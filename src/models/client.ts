import type {
  LoadModelCatalogOptions,
  ModelCatalogClientOptions,
} from "./client-runtime";
import type { ModelCatalogSnapshot } from "./types";

export type {
  LoadModelCatalogOptions,
  ModelCatalogAuthorization,
  ModelCatalogClientOptions,
} from "./client-runtime";

/** Lazy facade: catalog parsing and telemetry load only when discovery is used. */
export class ModelCatalogClient {
  private runtime?: import("./client-runtime").ModelCatalogClientRuntime;
  private loading?: Promise<import("./client-runtime").ModelCatalogClientRuntime>;
  private disposed = false;

  constructor(private readonly options: ModelCatalogClientOptions = {}) {}

  async load(options: LoadModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    return (await this.getRuntime()).load(options);
  }

  async refreshDebounced(options: LoadModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    return (await this.getRuntime()).refreshDebounced(options);
  }

  clearMemoryCache(): void {
    this.runtime?.clearMemoryCache();
  }

  dispose(): void {
    this.disposed = true;
    this.runtime?.dispose();
  }

  private async getRuntime(): Promise<import("./client-runtime").ModelCatalogClientRuntime> {
    if (this.disposed) throw new DOMException("Model catalog client was disposed.", "AbortError");
    const runtime = this.runtime ?? await (this.loading ??= import("./client-runtime")
      .then(({ ModelCatalogClientRuntime }) => new ModelCatalogClientRuntime(this.options)));
    if (this.disposed) {
      runtime.dispose();
      throw new DOMException("Model catalog client was disposed.", "AbortError");
    }
    this.runtime = runtime;
    return runtime;
  }
}
