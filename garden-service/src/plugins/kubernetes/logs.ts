/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as split from "split"
import moment = require("moment")
import Stream from "ts-stream"

import { GetServiceLogsResult, ServiceLogEntry } from "../../types/plugin/outputs"
import { GetServiceLogsParams } from "../../types/plugin/params"
import { ContainerModule } from "../container"
import { getAppNamespace } from "./namespace"
import { splitFirst } from "../../util/util"
import { BinaryCmd } from "../../util/ext-tools"
import { kubectl } from "./kubectl"
import { ContainerService } from "../../../tmp/dist/build/plugins/container"
import { LogEntry } from "../../logger/log-entry"

export async function getServiceLogs(
  { ctx, log, service, stream, tail }: GetServiceLogsParams<ContainerModule>,
) {
  const context = ctx.provider.config.context
  const namespace = await getAppNamespace(ctx, ctx.provider)

  const proc = tail
    ? await tailLogs(context, namespace, service, stream, log)
    : await getLogs(context, namespace, service, stream)

  return new Promise<GetServiceLogsResult>((resolve, reject) => {
    proc.on("error", reject)

    proc.on("exit", () => {
      resolve({})
    })
  })
}

async function tailLogs(
  context: string, namespace: string, service: ContainerService, stream: Stream<ServiceLogEntry>, log: LogEntry,
) {
  const args = [
    "--color", "never",
    "--context", context,
    "--namespace", namespace,
    "--output", "json",
    "--selector", `service=${service.name}`,
    "--timestamps",
  ]

  console.log(args.join(" "))

  const proc = await stern.spawn({ args, log })
  let timestamp: Date | undefined

  proc.stdout
    .pipe(split())
    .on("data", (line) => {
      if (!line || line[0] !== "{") {
        return
      }
      const obj = JSON.parse(line)
      const [timestampStr, msg] = splitFirst(obj.message, " ")
      try {
        timestamp = moment(timestampStr).toDate()
      } catch { }
      void stream.write({ serviceName: service.name, timestamp, msg: msg.trimRight() })
    })

  return proc
}

async function getLogs(
  context: string, namespace: string, service: ContainerService, stream: Stream<ServiceLogEntry>,
) {
  const resourceType = service.spec.daemon ? "daemonset" : "deployment"
  const kubectlArgs = ["logs", `${resourceType}/${service.name}`, "--timestamps=true"]

  const proc = kubectl(context, namespace).spawn(kubectlArgs)
  let timestamp: Date

  proc.stdout
    .pipe(split())
    .on("data", (s) => {
      if (!s) {
        return
      }
      const [timestampStr, msg] = splitFirst(s, " ")
      try {
        timestamp = moment(timestampStr).toDate()
      } catch { }
      void stream.write({ serviceName: service.name, timestamp, msg })
    })

  return proc
}

const stern = new BinaryCmd({
  name: "stern",
  specs: {
    darwin: {
      url: "https://github.com/wercker/stern/releases/download/1.10.0/stern_darwin_amd64",
      sha256: "b91dbcfd3bbda69cd7a7abd80a225ce5f6bb9d6255b7db192de84e80e4e547b7",
    },
    linux: {
      url: "https://github.com/wercker/stern/releases/download/1.10.0/stern_linux_amd64",
      sha256: "a0335b298f6a7922c35804bffb32a68508077b2f35aaef44d9eb116f36bc7eda",
    },
    win32: {
      url: "https://github.com/wercker/stern/releases/download/1.10.0/stern_windows_amd64.exe",
      sha256: "8cb94d3f47c831f2b0a59286336b41569ab38cb1528755545cb490536274f885",
    },
  },
})
