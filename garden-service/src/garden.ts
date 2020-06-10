/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"
import { ensureDir } from "fs-extra"
import dedent from "dedent"
import { platform, arch } from "os"
import { parse, relative, resolve, dirname } from "path"
import { flatten, isString, sortBy, fromPairs, keyBy, mapValues, omit } from "lodash"
const AsyncLock = require("async-lock")

import { TreeCache } from "./cache"
import { builtinPlugins } from "./plugins/plugins"
import { Module, getModuleCacheContext, getModuleKey, ModuleConfigMap, moduleFromConfig } from "./types/module"
import { pluginModuleSchema, ModuleTypeMap } from "./types/plugin/plugin"
import { SourceConfig, ProjectConfig, resolveProjectConfig, pickEnvironment, OutputSpec } from "./config/project"
import { findByName, pickKeys, getPackageVersion, getNames, findByNames } from "./util/util"
import { ConfigurationError, PluginError, RuntimeError } from "./exceptions"
import { VcsHandler, ModuleVersion } from "./vcs/vcs"
import { GitHandler } from "./vcs/git"
import { BuildDir } from "./build-dir"
import { ConfigGraph } from "./config-graph"
import { TaskGraph, TaskResults, ProcessTasksOpts } from "./task-graph"
import { getLogger } from "./logger/logger"
import { PluginActionHandlers, GardenPlugin } from "./types/plugin/plugin"
import { loadConfig, findProjectConfig, prepareModuleResource } from "./config/base"
import { DeepPrimitiveMap, StringMap } from "./config/common"
import { validateSchema } from "./config/validation"
import { BaseTask } from "./tasks/base"
import { LocalConfigStore, ConfigStore, GlobalConfigStore } from "./config-store"
import { getLinkedSources, ExternalSourceType } from "./util/ext-source-util"
import { BuildDependencyConfig, ModuleConfig, ModuleResource } from "./config/module"
import { resolveModuleConfig } from "./resolve-module"
import { ModuleConfigContext, OutputConfigContext } from "./config/config-context"
import { createPluginContext, CommandInfo } from "./plugin-context"
import { ModuleAndRuntimeActionHandlers, RegisterPluginParam } from "./types/plugin/plugin"
import { SUPPORTED_PLATFORMS, SupportedPlatform, DEFAULT_GARDEN_DIR_NAME } from "./constants"
import { LogEntry } from "./logger/log-entry"
import { EventBus } from "./events"
import { Watcher } from "./watch"
import {
  findConfigPathsInPath,
  getConfigFilePath,
  getWorkingCopyId,
  fixedExcludes,
  detectModuleOverlap,
  ModuleOverlap,
} from "./util/fs"
import {
  Provider,
  ProviderConfig,
  getAllProviderDependencyNames,
  defaultProvider,
  ProviderMap,
} from "./config/provider"
import { ResolveProviderTask } from "./tasks/resolve-provider"
import { ActionRouter } from "./actions"
import { RuntimeContext } from "./runtime-context"
import { loadPlugins, getDependencyOrder, getModuleTypes } from "./plugins"
import { deline, naturalList } from "./util/string"
import { ensureConnected } from "./db/connection"
import { DependencyValidationGraph } from "./util/validate-dependencies"
import { Profile } from "./util/profiling"
import { readAuthToken, checkClientAuthToken } from "./cloud/auth"
import { ResolveModuleTask, getResolvedModules } from "./tasks/resolve-module"
import { getSecrets } from "./cloud/secrets"
import username from "username"
import { throwOnMissingSecretKeys } from "./template-string"
import { WorkflowConfig, WorkflowResource, WorkflowConfigMap, resolveWorkflowConfig } from "./config/workflow"

export interface ActionHandlerMap<T extends keyof PluginActionHandlers> {
  [actionName: string]: PluginActionHandlers[T]
}

export interface ModuleActionHandlerMap<T extends keyof ModuleAndRuntimeActionHandlers> {
  [actionName: string]: ModuleAndRuntimeActionHandlers[T]
}

export type PluginActionMap = {
  [A in keyof PluginActionHandlers]: {
    [pluginName: string]: PluginActionHandlers[A]
  }
}

export type ModuleActionMap = {
  [A in keyof ModuleAndRuntimeActionHandlers]: {
    [moduleType: string]: {
      [pluginName: string]: ModuleAndRuntimeActionHandlers[A]
    }
  }
}

export interface GardenOpts {
  config?: ProjectConfig
  commandInfo?: CommandInfo
  gardenDirPath?: string
  environmentName?: string
  forceRefresh?: boolean
  persistent?: boolean
  log?: LogEntry
  plugins?: RegisterPluginParam[]
  sessionId?: string
  noPlatform?: boolean
}

export interface GardenParams {
  artifactsPath: string
  buildDir: BuildDir
  clientAuthToken: string | null
  dotIgnoreFiles: string[]
  environmentName: string
  allEnvironmentNames: string[]
  namespace?: string
  gardenDirPath: string
  log: LogEntry
  moduleIncludePatterns?: string[]
  moduleExcludePatterns?: string[]
  opts: GardenOpts
  outputs: OutputSpec[]
  projectId: string | null
  cloudDomain: string | null
  plugins: RegisterPluginParam[]
  production: boolean
  projectName: string
  projectRoot: string
  projectSources?: SourceConfig[]
  providerConfigs: ProviderConfig[]
  variables: DeepPrimitiveMap
  secrets: StringMap
  sessionId: string | null
  username: string | undefined
  vcs: VcsHandler
  workingCopyId: string
  forceRefresh?: boolean
}

@Profile()
export class Garden {
  public readonly log: LogEntry
  private loadedPlugins: GardenPlugin[]
  protected moduleConfigs: ModuleConfigMap
  protected workflowConfigs: WorkflowConfigMap
  private pluginModuleConfigs: ModuleConfig[]
  private resolvedProviders: { [key: string]: Provider }
  protected configsScanned: boolean
  public readonly registeredPlugins: { [key: string]: GardenPlugin }
  private readonly taskGraph: TaskGraph
  private watcher: Watcher
  private asyncLock: any

  // Platform-related instance variables
  public clientAuthToken: string | null
  public projectId: string | null
  public cloudDomain: string | null
  public sessionId: string | null

  public readonly configStore: ConfigStore
  public readonly globalConfigStore: GlobalConfigStore
  public readonly vcs: VcsHandler
  public readonly cache: TreeCache
  private actionHelper: ActionRouter
  public readonly events: EventBus

  public readonly production: boolean
  public readonly projectRoot: string
  public readonly projectName: string
  public readonly environmentName: string
  public readonly allEnvironmentNames: string[]
  public readonly namespace?: string
  public readonly variables: DeepPrimitiveMap
  public readonly secrets: StringMap
  public readonly projectSources: SourceConfig[]
  public readonly buildDir: BuildDir
  public readonly gardenDirPath: string
  public readonly artifactsPath: string
  public readonly opts: GardenOpts
  private readonly providerConfigs: ProviderConfig[]
  public readonly workingCopyId: string
  public readonly dotIgnoreFiles: string[]
  public readonly moduleIncludePatterns?: string[]
  public readonly moduleExcludePatterns: string[]
  public readonly persistent: boolean
  public readonly rawOutputs: OutputSpec[]
  public readonly systemNamespace: string
  public readonly username?: string
  public readonly version: ModuleVersion
  private readonly forceRefresh: boolean

  constructor(params: GardenParams) {
    this.buildDir = params.buildDir
    this.clientAuthToken = params.clientAuthToken
    this.cloudDomain = params.cloudDomain
    this.sessionId = params.sessionId
    this.environmentName = params.environmentName
    this.allEnvironmentNames = params.allEnvironmentNames
    this.namespace = params.namespace
    this.gardenDirPath = params.gardenDirPath
    this.log = params.log
    this.artifactsPath = params.artifactsPath
    this.opts = params.opts
    this.rawOutputs = params.outputs
    this.production = params.production
    this.projectName = params.projectName
    this.projectId = params.projectId
    this.projectRoot = params.projectRoot
    this.projectSources = params.projectSources || []
    this.providerConfigs = params.providerConfigs
    this.variables = params.variables
    this.secrets = params.secrets
    this.workingCopyId = params.workingCopyId
    this.dotIgnoreFiles = params.dotIgnoreFiles
    this.moduleIncludePatterns = params.moduleIncludePatterns
    this.moduleExcludePatterns = params.moduleExcludePatterns || []
    this.asyncLock = new AsyncLock()
    this.persistent = !!params.opts.persistent
    this.username = params.username
    this.vcs = params.vcs
    this.forceRefresh = !!params.forceRefresh

    // make sure we're on a supported platform
    const currentPlatform = platform()
    const currentArch = arch()

    if (!SUPPORTED_PLATFORMS.includes(<SupportedPlatform>currentPlatform)) {
      throw new RuntimeError(`Unsupported platform: ${currentPlatform}`, { platform: currentPlatform })
    }

    if (currentArch !== "x64") {
      throw new RuntimeError(`Unsupported CPU architecture: ${currentArch}`, { arch: currentArch })
    }

    this.configsScanned = false
    // TODO: Support other VCS options.
    this.configStore = new LocalConfigStore(this.gardenDirPath)
    this.globalConfigStore = new GlobalConfigStore()
    this.cache = new TreeCache()

    this.moduleConfigs = {}
    this.pluginModuleConfigs = []
    this.workflowConfigs = {}
    this.registeredPlugins = {}
    this.resolvedProviders = {}

    this.taskGraph = new TaskGraph(this, this.log)
    this.events = new EventBus()

    // Register plugins
    for (const plugin of [...builtinPlugins, ...params.plugins]) {
      this.registerPlugin(plugin)
    }

    // TODO: actually resolve version, based on the VCS version of the plugin and its dependencies
    this.version = {
      versionString: getPackageVersion(),
      dependencyVersions: {},
      files: [],
    }
  }

  static async factory<T extends typeof Garden>(
    this: T,
    currentDirectory: string,
    opts: GardenOpts = {}
  ): Promise<InstanceType<T>> {
    let { environmentName: environmentStr, config, gardenDirPath, plugins = [] } = opts

    if (!config) {
      config = await findProjectConfig(currentDirectory)

      if (!config) {
        throw new ConfigurationError(
          `Not a project directory (or any of the parent directories): ${currentDirectory}`,
          { currentDirectory }
        )
      }
    }

    gardenDirPath = resolve(config.path, gardenDirPath || DEFAULT_GARDEN_DIR_NAME)
    await ensureDir(gardenDirPath)

    const artifactsPath = resolve(gardenDirPath, "artifacts")
    await ensureDir(artifactsPath)

    const _username = (await username()) || ""
    config = resolveProjectConfig(config, artifactsPath, _username)

    const { defaultEnvironment, name: projectName, sources: projectSources, path: projectRoot } = config

    if (!environmentStr) {
      environmentStr = defaultEnvironment
    }

    const environmentNames = config.environments.map((env) => env.name)
    const { environmentName, namespace, providers, variables, production } = await pickEnvironment(
      config,
      environmentStr
    )

    const buildDir = await BuildDir.factory(projectRoot, gardenDirPath)
    const workingCopyId = await getWorkingCopyId(gardenDirPath)
    const log = opts.log || getLogger().placeholder()

    // We always exclude the garden dir
    const gardenDirExcludePattern = `${relative(projectRoot, gardenDirPath)}/**/*`
    const moduleExcludePatterns = [...((config.modules || {}).exclude || []), gardenDirExcludePattern, ...fixedExcludes]

    // Ensure the project root is in a git repo
    const vcs = new GitHandler(gardenDirPath, config.dotIgnoreFiles)
    await vcs.getRepoRoot(log, projectRoot)

    // Connect to the state storage
    await ensureConnected()

    const sessionId = opts.sessionId || null

    const { id: projectId, domain: cloudDomain } = config

    let secrets = {}
    const clientAuthToken = await readAuthToken(log)
    // If a client auth token exists in local storage, we assume that the user wants to be logged in to the platform.
    if (clientAuthToken && !opts.noPlatform) {
      if (!cloudDomain || !projectId) {
        const errorMessages: string[] = []
        if (!cloudDomain) {
          errorMessages.push(deline`
            ${chalk.bold("project.domain")} is not set in your project-level ${chalk.bold("garden.yml")}. Make sure it
            is set to the appropriate API backend endpoint (e.g. myusername-cloud-api.cloud.dev.garden.io, without an
            http/https prefix).
          `)
        }
        if (!projectId) {
          errorMessages.push(deline`
            ${chalk.bold("project.id")} is not set in your project-level ${chalk.bold("garden.yml")}. Please visit
            Garden Cloud's web UI for your project and copy your project's ID from there.
          `)
        }
        if (errorMessages.length > 0) {
          throw new ConfigurationError(
            dedent`
              ${errorMessages.join("\n\n")}

              Logging out via the ${chalk.bold("garden logout")} command will suppress this message.`,
            {}
          )
        }
      } else {
        const tokenIsValid = await checkClientAuthToken(clientAuthToken, cloudDomain, log)
        if (tokenIsValid) {
          secrets = await getSecrets({
            projectId,
            cloudDomain,
            clientAuthToken,
            log,
            environmentName,
          })
        } else {
          log.warn(deline`
            You were previously logged in to the platform, but your session has expired or is invalid. Please run
            ${chalk.bold("garden login")} to continue using platform features, or run ${chalk.bold("garden logout")}
            to suppress this message.
          `)
        }
      }
    }

    const garden = new this({
      artifactsPath,
      clientAuthToken,
      sessionId,
      cloudDomain: cloudDomain || null,
      projectId: projectId || null,
      projectRoot,
      projectName,
      environmentName,
      allEnvironmentNames: environmentNames,
      namespace,
      variables,
      secrets,
      projectSources,
      buildDir,
      production,
      gardenDirPath,
      opts,
      outputs: config.outputs || [],
      plugins,
      providerConfigs: providers,
      moduleExcludePatterns,
      workingCopyId,
      dotIgnoreFiles: config.dotIgnoreFiles,
      moduleIncludePatterns: (config.modules || {}).include,
      log,
      username: _username,
      vcs,
      forceRefresh: opts.forceRefresh,
    }) as InstanceType<T>

    return garden
  }

  /**
   * Clean up before shutting down.
   */
  async close() {
    this.events.removeAllListeners()
    this.watcher && (await this.watcher.stop())
  }

  getPluginContext(provider: Provider) {
    return createPluginContext(this, provider, this.opts.commandInfo)
  }

  async clearBuilds() {
    return this.buildDir.clear()
  }

  async processTasks(tasks: BaseTask[], opts?: ProcessTasksOpts): Promise<TaskResults> {
    return this.taskGraph.process(tasks, opts)
  }

  /**
   * Enables the file watcher for the project.
   * Make sure to stop it using `.close()` when cleaning up or when watching is no longer needed.
   */
  async startWatcher(graph: ConfigGraph, bufferInterval?: number) {
    const modules = graph.getModules()
    const linkedPaths = (await getLinkedSources(this)).map((s) => s.path)
    const paths = [this.projectRoot, ...linkedPaths]
    this.watcher = new Watcher(this, this.log, paths, modules, bufferInterval)
  }

  private registerPlugin(nameOrPlugin: RegisterPluginParam) {
    let plugin: GardenPlugin

    if (isString(nameOrPlugin)) {
      let moduleNameOrLocation = nameOrPlugin

      // allow relative references to project root
      if (parse(moduleNameOrLocation).dir !== "") {
        moduleNameOrLocation = resolve(this.projectRoot, moduleNameOrLocation)
      }

      let pluginModule: any

      try {
        pluginModule = require(moduleNameOrLocation)
      } catch (error) {
        throw new ConfigurationError(
          `Unable to load plugin "${moduleNameOrLocation}" (could not load module: ${error.message})`,
          {
            message: error.message,
            moduleNameOrLocation,
          }
        )
      }

      try {
        pluginModule = validateSchema(pluginModule, pluginModuleSchema(), {
          context: `plugin module "${moduleNameOrLocation}"`,
        })
      } catch (err) {
        throw new PluginError(`Unable to load plugin: ${err}`, {
          moduleNameOrLocation,
          err,
        })
      }

      plugin = pluginModule.gardenPlugin
    } else {
      plugin = nameOrPlugin
    }

    this.registeredPlugins[plugin.name] = plugin
  }

  async getPlugin(pluginName: string): Promise<GardenPlugin> {
    const plugins = await this.getPlugins()
    const plugin = findByName(plugins, pluginName)

    if (!plugin) {
      const availablePlugins = getNames(plugins)
      throw new PluginError(
        `Could not find plugin '${pluginName}'. Are you missing a provider configuration? ` +
          `Currently configured plugins: ${availablePlugins.join(", ")}`,
        {
          pluginName,
          availablePlugins,
        }
      )
    }

    return plugin
  }

  async getPlugins() {
    // The duplicated check is a small optimization to avoid the async lock when possible,
    // since this is called quite frequently.
    if (this.loadedPlugins) {
      return this.loadedPlugins
    }

    await this.asyncLock.acquire("load-plugins", async () => {
      // This check is necessary since we could in theory have two calls waiting for the lock at the same time.
      if (this.loadedPlugins) {
        return
      }

      this.log.silly(`Loading plugins`)
      const rawConfigs = this.getRawProviderConfigs()

      this.loadedPlugins = loadPlugins(this.log, this.registeredPlugins, rawConfigs)

      this.log.silly(`Loaded plugins: ${rawConfigs.map((c) => c.name).join(", ")}`)
    })

    return this.loadedPlugins
  }

  /**
   * Returns a mapping of all configured module types in the project and their definitions.
   */
  async getModuleTypes(): Promise<ModuleTypeMap> {
    const plugins = await this.getPlugins()
    const configNames = keyBy(this.getRawProviderConfigs(), "name")
    const configuredPlugins = plugins.filter((p) => configNames[p.name])

    return getModuleTypes(configuredPlugins)
  }

  getRawProviderConfigs(names?: string[]) {
    return names ? findByNames(names, this.providerConfigs, "provider") : this.providerConfigs
  }

  async resolveProvider(name: string) {
    this.log.silly(`Resolving provider ${name}`)
    if (name === "_default") {
      return defaultProvider
    }

    if (this.resolvedProviders[name]) {
      return this.resolvedProviders[name]
    }

    const providers = await this.resolveProviders(false, [name])
    const provider = providers[name]

    if (!provider) {
      const providerNames = Object.keys(providers)
      throw new PluginError(
        `Could not find provider '${name}' in environment '${this.environmentName}' ` +
          `(configured providers: ${providerNames.join(", ")})`,
        {
          name,
          providers,
        }
      )
    }

    return provider
  }

  async resolveProviders(forceInit = false, names?: string[]): Promise<ProviderMap> {
    let providers: Provider[] = []

    await this.asyncLock.acquire("resolve-providers", async () => {
      const rawConfigs = this.getRawProviderConfigs(names)

      if (!names) {
        names = getNames(rawConfigs)
      }

      throwOnMissingSecretKeys(Object.fromEntries(rawConfigs.map((c) => [c.name, c])), this.secrets, "Provider")

      // As an optimization, we return immediately if all requested providers are already resolved
      const alreadyResolvedProviders = names.map((name) => this.resolvedProviders[name]).filter(Boolean)
      if (alreadyResolvedProviders.length === names.length) {
        providers = alreadyResolvedProviders
        return
      }

      this.log.silly(`Resolving providers`)

      const log = this.log.info({
        section: "providers",
        msg: "Getting status...",
        status: "active",
      })

      const plugins = keyBy(await this.getPlugins(), "name")

      // Detect circular dependencies here
      const validationGraph = new DependencyValidationGraph()

      await Bluebird.map(rawConfigs, async (config) => {
        const plugin = plugins[config.name]
        validationGraph.addNode(plugin.name)

        for (const dep of await getAllProviderDependencyNames(plugin!, config!)) {
          validationGraph.addNode(dep)
          validationGraph.addDependency(plugin.name, dep)
        }
      })

      const cycles = validationGraph.detectCircularDependencies()

      if (cycles.length > 0) {
        const description = validationGraph.cyclesToString(cycles)
        throw new PluginError(
          `One or more circular dependencies found between providers or their configurations:\n\n${description}`,
          { "circular-dependencies": description }
        )
      }

      const tasks = rawConfigs.map((config) => {
        const plugin = plugins[config.name]

        return new ResolveProviderTask({
          garden: this,
          log,
          plugin,
          config,
          version: this.version,
          forceRefresh: this.forceRefresh,
          forceInit,
        })
      })

      // Process as many providers in parallel as possible
      const taskResults = await this.processTasks(tasks, { unlimitedConcurrency: true })

      const failed = Object.values(taskResults).filter((r) => r && r.error)

      if (failed.length) {
        const messages = failed.map((r) => `- ${r!.name}: ${r!.error!.message}`)
        const failedNames = failed.map((r) => r!.name)
        throw new PluginError(`Failed resolving one or more providers:\n- ${failedNames.join("\n- ")}`, {
          rawConfigs,
          taskResults,
          messages,
        })
      }

      providers = Object.values(taskResults).map((result) => result!.output)

      const gotCachedResult = !!providers.find((p) => p.status.cached)

      await Bluebird.map(providers, async (provider) =>
        Bluebird.map(provider.moduleConfigs, async (moduleConfig) => {
          // Make sure module and all nested entities are scoped to the plugin
          moduleConfig.plugin = provider.name
          return this.addModule(moduleConfig)
        })
      )

      for (const provider of providers) {
        this.resolvedProviders[provider.name] = provider
      }

      if (gotCachedResult) {
        log.setSuccess({ msg: chalk.green("Cached"), append: true })
        log.info({
          symbol: "info",
          msg: chalk.gray("Run with --force-refresh to force a refresh of provider statuses."),
        })
      } else {
        log.setSuccess({ msg: chalk.green("Done"), append: true })
      }

      this.log.silly(`Resolved providers: ${providers.map((p) => p.name).join(", ")}`)
    })

    return keyBy(providers, "name")
  }

  getRawWorkflowConfig(name: string) {
    return this.getRawWorkflowConfigs([name])[0]
  }

  getRawWorkflowConfigs(names?: string[]) {
    if (names) {
      return Object.values(pickKeys(this.workflowConfigs, names, "workflow"))
    } else {
      return Object.values(this.workflowConfigs)
    }
  }

  async getWorkflowConfig(name: string): Promise<WorkflowConfig> {
    return (await this.getWorkflowConfigs([name]))[0]
  }

  async getWorkflowConfigs(names?: string[]): Promise<WorkflowConfig[]> {
    const providers = await this.resolveProviders()
    const configs = this.getRawWorkflowConfigs(names)
    return configs.map((config) => resolveWorkflowConfig(this, providers, config))
  }

  /**
   * Returns the reported status from all configured providers.
   */
  async getEnvironmentStatus() {
    const providers = await this.resolveProviders()
    return mapValues(providers, (p) => p.status)
  }

  async getActionRouter() {
    if (!this.actionHelper) {
      const loadedPlugins = await this.getPlugins()
      const moduleTypes = await this.getModuleTypes()
      const plugins = keyBy(loadedPlugins, "name")

      // We only pass configured plugins to the router (others won't have the required configuration to call handlers)
      const configuredPlugins = this.getRawProviderConfigs().map((c) => plugins[c.name])

      this.actionHelper = new ActionRouter(this, configuredPlugins, loadedPlugins, moduleTypes)
    }

    return this.actionHelper
  }

  /**
   * Returns module configs that are registered in this context, before template resolution and validation.
   * Scans for modules in the project root and remote/linked sources if it hasn't already been done.
   */
  async getRawModuleConfigs(keys?: string[]): Promise<ModuleConfig[]> {
    if (!this.configsScanned) {
      await this.scanAndAddConfigs()
    }

    return Object.values(keys ? pickKeys(this.moduleConfigs, keys, "module config") : this.moduleConfigs)
  }

  async getOutputConfigContext(modules: Module[], runtimeContext: RuntimeContext) {
    const providers = await this.resolveProviders()
    return new OutputConfigContext({
      garden: this,
      resolvedProviders: providers,
      variables: this.variables,
      secrets: this.secrets,
      modules,
      runtimeContext,
    })
  }

  /**
   * Resolve the raw module configs and return a new instance of ConfigGraph.
   * The graph instance is immutable and represents the configuration at the point of calling this method.
   * For long-running processes, you need to call this again when any module or configuration has been updated.
   */
  async getConfigGraph(log: LogEntry, runtimeContext?: RuntimeContext) {
    const providers = await this.resolveProviders()
    const configs = await this.getRawModuleConfigs()
    this.log.silly(`Resolving module configs`)
    // Resolve the project module configs
    const tasks = configs.map(
      (moduleConfig) =>
        new ResolveModuleTask({ garden: this, log, moduleConfig, resolvedProviders: providers, runtimeContext })
    )

    let results: TaskResults

    try {
      results = await this.processTasks(tasks, { unlimitedConcurrency: true })
    } catch (err) {
      // Wrap the circular dependency error to print a more specific message
      if (err.type === "circular-dependencies") {
        const cycles = err.cycles.map((c: string[][]) => {
          // Get the module name of the the cycle (anything else is internal detail as far as users are concerned)
          return c.map((cycle) => cycle.map((key) => key.split(".")[1]))
        })
        throw new ConfigurationError(
          `Detected one or more circular dependencies between module configurations:\n\n${cycles.join("\n")}`,
          { cycles }
        )
      } else {
        throw err
      }
    }

    const failed = Object.values(results).filter((r) => r?.error)

    if (failed.length > 0) {
      const errors = failed.map((r) => `${chalk.white.bold(r!.name)}: ${r?.error?.message}`)

      throw new ConfigurationError(chalk.red(`Failed resolving one or more modules:\n\n${errors.join("\n")}`), {
        results,
        errors,
      })
    }
    const resolvedModules = getResolvedModules(results)

    const actions = await this.getActionRouter()
    const moduleTypes = await this.getModuleTypes()

    let graph: ConfigGraph | undefined = undefined

    // Require include/exclude on modules if their paths overlap
    const overlaps = detectModuleOverlap(resolvedModules)
    if (overlaps.length > 0) {
      const { message, detail } = this.makeOverlapError(overlaps)
      throw new ConfigurationError(message, detail)
    }

    // Walk through all plugins in dependency order, and allow them to augment the graph
    for (const provider of getDependencyOrder(Object.values(providers), this.registeredPlugins)) {
      // Skip the routine if the provider doesn't have the handler
      const handler = await actions.getActionHandler({
        actionType: "augmentGraph",
        pluginName: provider.name,
        throwIfMissing: false,
      })

      if (!handler) {
        continue
      }

      // We clear the graph below whenever an augmentGraph handler adds/modifies modules, and re-init here, in order
      // to ensure the dependency structure is alright.
      if (!graph) {
        graph = new ConfigGraph(resolvedModules, moduleTypes)
      }

      const { addBuildDependencies, addRuntimeDependencies, addModules } = await actions.augmentGraph({
        pluginName: provider.name,
        log,
        providers,
        modules: resolvedModules,
      })

      const configContext = new ModuleConfigContext({
        garden: this,
        resolvedProviders: keyBy(providers, "name"),
        variables: this.variables,
        secrets: this.secrets,
        dependencyConfigs: resolvedModules,
        dependencyVersions: fromPairs(resolvedModules.map((m) => [m.name, m.version])),
        runtimeContext,
      })

      // Resolve modules from specs and add to the list
      await Bluebird.map(addModules || [], async (spec) => {
        const path = spec.path || this.projectRoot
        const moduleConfig = prepareModuleResource(spec, path, path, this.projectRoot)
        const resolvedConfig = await resolveModuleConfig(this, moduleConfig, { configContext })
        resolvedModules.push(await moduleFromConfig(this, resolvedConfig, resolvedModules))
        graph = undefined
      })

      // Note: For both kinds of dependencies we only validate that `by` resolves correctly, since the rest
      // (i.e. whether all `on` references exist + circular deps) will be validated when initiating the ConfigGraph.
      for (const dependency of addBuildDependencies || []) {
        const by = findByName(resolvedModules, dependency.by)

        if (!by) {
          throw new PluginError(
            deline`
              Provider '${provider.name}' added a build dependency by module '${dependency.by}' on '${dependency.on}'
              but module '${dependency.by}' could not be found.
            `,
            { provider, dependency }
          )
        }

        // TODO: allow copy directives on build dependencies?
        by.build.dependencies.push({ name: dependency.on, copy: [] })
        graph = undefined
      }

      for (const dependency of addRuntimeDependencies || []) {
        let found = false

        for (const moduleConfig of resolvedModules) {
          for (const serviceConfig of moduleConfig.serviceConfigs) {
            if (serviceConfig.name === dependency.by) {
              serviceConfig.dependencies.push(dependency.on)
              found = true
            }
          }
          for (const taskConfig of moduleConfig.taskConfigs) {
            if (taskConfig.name === dependency.by) {
              taskConfig.dependencies.push(dependency.on)
              found = true
            }
          }
        }

        if (!found) {
          throw new PluginError(
            deline`
              Provider '${provider.name}' added a runtime dependency by '${dependency.by}' on '${dependency.on}'
              but service or task '${dependency.by}' could not be found.
            `,
            { provider, dependency }
          )
        }

        graph = undefined
      }
    }

    // Ensure dependency structure is alright
    graph = new ConfigGraph(resolvedModules, moduleTypes)

    // Need to update versions and add the build dependency modules to the Module objects here, because plugins can
    // add build dependencies in the configure handler.
    // FIXME: This should be addressed higher up in the process, but is quite tricky to manage with the current
    // TaskGraph structure which (understandably nb.) needs the dependency structure to be pre-determined before
    // processing.
    const modulesByName = keyBy(resolvedModules, "name")

    await Bluebird.map(resolvedModules, async (module) => {
      const buildDeps = module.build.dependencies.map((d) => {
        const key = getModuleKey(d.name, d.plugin)
        const depModule = modulesByName[key]

        if (!depModule) {
          throw new ConfigurationError(
            chalk.red(deline`
            Module ${chalk.white.bold(module.name)} specifies build dependency ${chalk.white.bold(key)} which
            cannot be found.
            `),
            { dependencyName: key }
          )
        }

        return depModule
      })

      module.buildDependencies = fromPairs(buildDeps.map((d) => [getModuleKey(d.name, d.plugin), d]))
      module.version = await this.resolveVersion(module, buildDeps)
    })

    return graph
  }

  /**
   * Given a module, and a list of dependencies, resolve the version for that combination of modules.
   * The combined version is a either the latest dirty module version (if any), or the hash of the module version
   * and the versions of its dependencies (in sorted order).
   */
  async resolveVersion(
    moduleConfig: ModuleConfig,
    moduleDependencies: (Module | BuildDependencyConfig)[],
    force = false
  ) {
    const moduleName = moduleConfig.name
    const depModuleNames = moduleDependencies.map((m) => m.name)
    depModuleNames.sort()
    const cacheKey = ["moduleVersions", moduleName, ...depModuleNames]

    if (!force) {
      const cached = <ModuleVersion>this.cache.get(cacheKey)

      if (cached) {
        return cached
      }
    }

    this.log.silly(`Resolving version for module ${moduleName}`)

    const dependencyKeys = moduleDependencies.map((dep) => getModuleKey(dep.name, dep.plugin))
    const dependencies = await this.getRawModuleConfigs(dependencyKeys)
    const cacheContexts = dependencies.concat([moduleConfig]).map((c) => getModuleCacheContext(c))

    const version = await this.vcs.resolveVersion(this.log, moduleConfig, dependencies)

    this.cache.set(cacheKey, version, ...cacheContexts)
    return version
  }

  /**
   * Scans the specified directories for Garden config files and returns a list of paths.
   */
  async scanForConfigs(path: string) {
    this.log.silly(`Scanning for configs in ${path}`)

    return findConfigPathsInPath({
      vcs: this.vcs,
      dir: path,
      include: this.moduleIncludePatterns,
      exclude: this.moduleExcludePatterns,
      log: this.log,
    })
  }

  /*
    Scans the project root for modules and workflows and adds them to the context.
   */
  async scanAndAddConfigs(force = false) {
    return this.asyncLock.acquire("scan-configs", async () => {
      if (this.configsScanned && !force) {
        return
      }

      this.log.silly(`Scanning for modules and workflows`)

      let extSourcePaths: string[] = []

      // Add external sources that are defined at the project level. External sources are either kept in
      // the .garden/sources dir (and cloned there if needed), or they're linked to a local path via the link command.
      for (const { name, repositoryUrl } of this.projectSources) {
        const path = await this.loadExtSourcePath({
          name,
          repositoryUrl,
          sourceType: "project",
        })
        extSourcePaths.push(path)
      }

      const dirsToScan = [this.projectRoot, ...extSourcePaths]
      const configPaths = flatten(await Bluebird.map(dirsToScan, (path) => this.scanForConfigs(path)))

      const rawModuleConfigs: ModuleConfig[] = [...this.pluginModuleConfigs]
      const rawWorkflowConfigs: WorkflowConfig[] = []

      await Bluebird.map(configPaths, async (path) => {
        const configs = await this.loadConfigs(dirname(path))
        if (configs) {
          const moduleConfigs = <ModuleResource[]>configs.filter((c) => c.kind === "Module")
          const workflowConfigs = <WorkflowResource[]>configs.filter((c) => c.kind === "Workflow")
          rawModuleConfigs.push(...moduleConfigs)
          rawWorkflowConfigs.push(...workflowConfigs)
        }
      })

      throwOnMissingSecretKeys(Object.fromEntries(rawModuleConfigs.map((c) => [c.name, c])), this.secrets, "Module")
      throwOnMissingSecretKeys(Object.fromEntries(rawWorkflowConfigs.map((c) => [c.name, c])), this.secrets, "Workflow")

      await Bluebird.all([
        Bluebird.map(rawModuleConfigs, async (config) => this.addModule(config)),
        Bluebird.map(rawWorkflowConfigs, async (config) => this.addWorkflow(config)),
      ])

      this.log.silly(`Scanned and found ${rawModuleConfigs.length} modules and ${rawWorkflowConfigs.length} workflows`)

      this.configsScanned = true
    })
  }

  /**
   * Returns true if a module has been configured in this project with the specified name.
   */
  hasModule(name: string) {
    return !!this.moduleConfigs[name]
  }

  /**
   * Add a module config to the context, after validating and calling the appropriate configure plugin handler.
   */
  private async addModule(config: ModuleConfig) {
    const key = getModuleKey(config.name, config.plugin)
    this.log.silly(`Adding module ${key}`)

    if (this.moduleConfigs[key]) {
      const paths = [this.moduleConfigs[key].path, config.path]
      const [pathA, pathB] = (
        await Bluebird.map(paths, async (path) => relative(this.projectRoot, await getConfigFilePath(path)))
      ).sort()

      throw new ConfigurationError(`Module ${key} is declared multiple times (in '${pathA}' and '${pathB}')`, {
        pathA,
        pathB,
      })
    }

    this.moduleConfigs[key] = config
  }

  /**
   * Add a workflow config to the context after validating that its name doesn't conflict with
   * previously added workflows.
   */
  private async addWorkflow(config: WorkflowConfig) {
    const key = config.name
    this.log.silly(`Adding workflow ${key}`)

    if (this.workflowConfigs[key]) {
      const paths = [this.workflowConfigs[key].path, config.path]
      const [pathA, pathB] = (
        await Bluebird.map(paths, async (path) => relative(this.projectRoot, await getConfigFilePath(path)))
      ).sort()

      throw new ConfigurationError(`Workflow ${key} is declared multiple times (in '${pathA}' and '${pathB}')`, {
        pathA,
        pathB,
      })
    }

    this.workflowConfigs[key] = config
  }

  /**
   * Load a module and/or a workflow from the specified directory and return the configs,
   * or null if no module or workflow is found.
   *
   * @param path Directory containing the module
   */
  private async loadConfigs(path: string): Promise<(ModuleResource | WorkflowResource)[]> {
    path = resolve(this.projectRoot, path)
    this.log.silly(`Load module and workflow configs from ${path}`)
    const resources = await loadConfig(this.projectRoot, path)
    this.log.silly(`Loaded module and workflow configs from ${path}`)
    return <(ModuleResource | WorkflowResource)[]>resources.filter((r) => r.kind === "Module" || r.kind === "Workflow")
  }

  //===========================================================================
  //region Internal helpers
  //===========================================================================

  /**
   * Clones the project/module source if needed and returns the path (either from .garden/sources or from a local path)
   */
  public async loadExtSourcePath({
    name,
    repositoryUrl,
    sourceType,
  }: {
    name: string
    repositoryUrl: string
    sourceType: ExternalSourceType
  }): Promise<string> {
    const linkedSources = await getLinkedSources(this, sourceType)

    const linked = findByName(linkedSources, name)

    if (linked) {
      return linked.path
    }

    const path = await this.vcs.ensureRemoteSource({
      name,
      sourceType,
      url: repositoryUrl,
      log: this.log,
    })

    return path
  }

  public makeOverlapError(moduleOverlaps: ModuleOverlap[]) {
    const overlapList = moduleOverlaps
      .map(({ module, overlaps }) => {
        const formatted = overlaps.map((o) => {
          const detail = o.path === module.path ? "same path" : "nested"
          return `${chalk.bold(o.name)} (${detail})`
        })
        return `Module ${chalk.bold(module.name)} overlaps with module(s) ${naturalList(formatted)}.`
      })
      .join("\n\n")
    const message = chalk.red(dedent`
      Missing ${chalk.bold("include")} and/or ${chalk.bold("exclude")} directives on modules with overlapping paths.
      Setting includes/excludes is required when modules have the same path (i.e. are in the same garden.yml file),
      or when one module is nested within another.

      ${overlapList}
    `)
    // Sanitize error details
    const overlappingModules = moduleOverlaps.map(({ module, overlaps }) => {
      return {
        module: { name: module.name, path: resolve(this.projectRoot, module.path) },
        overlaps: overlaps.map(({ name, path }) => ({ name, path: resolve(this.projectRoot, path) })),
      }
    })
    return { message, detail: { overlappingModules } }
  }

  /**
   * This dumps the full project configuration including all modules.
   */
  public async dumpConfig(log: LogEntry, includeDisabled: boolean = false): Promise<ConfigDump> {
    const graph = await this.getConfigGraph(log)
    const modules = graph.getModules({ includeDisabled })
    const workflowConfigs = await this.getWorkflowConfigs()

    return {
      environmentName: this.environmentName,
      namespace: this.namespace,
      providers: Object.values(await this.resolveProviders()).map((p) => omit(p, ["tools"])),
      variables: this.variables,
      moduleConfigs: sortBy(
        modules.map((m) => m._config),
        "name"
      ),
      workflowConfigs: sortBy(workflowConfigs, "name"),
      projectRoot: this.projectRoot,
      projectId: this.projectId,
    }
  }

  //endregion
}

export interface ConfigDump {
  environmentName: string
  namespace?: string
  providers: Omit<Provider, "tools">[]
  variables: DeepPrimitiveMap
  moduleConfigs: ModuleConfig[]
  workflowConfigs: WorkflowConfig[]
  projectRoot: string
  projectId: string | null
}
