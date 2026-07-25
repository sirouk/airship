import type {
  BrowserLocalModelProvider,
  LocalModelProviderKind,
  LocalProviderOptions,
} from "./contracts";
import { LmStudioBrowserProvider } from "./lm-studio";
import { OllamaBrowserProvider } from "./ollama";

export function createBrowserLocalModelProvider(
  kind: LocalModelProviderKind,
  options: LocalProviderOptions = {},
): BrowserLocalModelProvider {
  return kind === "ollama"
    ? new OllamaBrowserProvider(options)
    : new LmStudioBrowserProvider(options);
}

