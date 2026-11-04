import { offerInstalledCompletion } from "./postinstall.js";

// Shell integration is optional and must never make package installation fail.
await offerInstalledCompletion().catch(() => undefined);
