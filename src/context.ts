import { parse, relative } from "path"
import { LoggerInstance } from "winston"
import { loadModuleConfig } from "./types/module-config"
import { loadProjectConfig, ProjectConfig } from "./types/project-config"
import { getIgnorer, getLogger, scanDirectory } from "./util"
import { MODULE_CONFIG_FILENAME } from "./constants"
import { ConfigurationError, PluginError } from "./exceptions"
import { VcsHandler } from "./vcs/base"
import { GitHandler } from "./vcs/git"
import { ModuleConstructor, ModuleHandler } from "./moduleHandlers/base"
import { ContainerModule } from "./moduleHandlers/container"
import { FunctionModule } from "./moduleHandlers/function"
import { NpmPackageModule } from "./moduleHandlers/npm-package"

interface ModuleMap { [ key: string]: ModuleHandler }

export class GardenContext {
  public log: LoggerInstance

  private config: ProjectConfig
  private moduleTypes: { [ key: string]: ModuleConstructor }
  private modules: ModuleMap

  vcs: VcsHandler

  constructor(public projectRoot: string, logger?: LoggerInstance) {
    this.log = logger || getLogger()
    this.config = loadProjectConfig(this.projectRoot)
    // TODO: Support other VCS options.
    this.vcs = new GitHandler(this)

    this.moduleTypes = {}

    // Load built-in module handlers
    this.addModuleHandler("container", ContainerModule)
    this.addModuleHandler("function", FunctionModule)
    this.addModuleHandler("npm-package", NpmPackageModule)
  }

  addModuleHandler(typeName: string, moduleType: ModuleConstructor) {
    if (this.moduleTypes[typeName]) {
      throw new PluginError(`Module type ${typeName} declared more than once`, {
        previous: this.moduleTypes[typeName],
        adding: moduleType,
      })
    }

    this.moduleTypes[typeName] = moduleType
  }

  async getModules(): Promise<ModuleMap> {
    if (!this.modules) {
      const modules: ModuleMap = {}
      const ignorer = getIgnorer(this.projectRoot)
      const scanOpts = {
        filter: (path) => {
          const relPath = relative(this.projectRoot, path)
          return !ignorer.ignores(relPath)
        },
      }

      for await (const item of scanDirectory(this.projectRoot, scanOpts)) {
        const parsedPath = parse(item.path)
        if (parsedPath.base === MODULE_CONFIG_FILENAME) {
          const modulePath = parsedPath.dir
          const config = await loadModuleConfig(modulePath)

          if (modules[config.name]) {
            const pathA = modules[config.name].path
            const pathB = relative(this.projectRoot, item.path)

            throw new ConfigurationError(
              `Module ${config.name} is declared multiple times ('${pathA}' and '${pathB}')`,
              {
                pathA,
                pathB,
              },
            )
          }

          const handlerType = this.moduleTypes[config.type]

          if (!handlerType) {
            throw new ConfigurationError(`Unrecognized module type: ${config.type}`, {
              type: config.type,
            })
          }

          modules[config.name] = new handlerType(this, modulePath, config)
        }
      }

      this.modules = modules
    }
    return this.modules
  }
}
