export interface PluginBootstrapResult {
  status: "scaffold";
  message: string;
}

export function bootstrapPlugin(): PluginBootstrapResult {
  return {
    status: "scaffold",
    message: "Base structure only. Runtime implementation is pending."
  };
}
