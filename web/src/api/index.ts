import type { AlmadelClient } from "./client"
import { HttpClient } from "./http"
import { MockClient } from "./mock/client"

// Mock mode is the default everywhere except a production build, where the
// almadel server serves the built assets and the browser-facing API from the
// same origin. `import.meta.env.PROD` is Vite-injected (true only under
// `vite build`); in dev and under `bun test` it is undefined/false, so the mock
// is used. An explicit VITE_ALMADEL_MOCK value always wins: "0"/"false" forces
// the real client, anything else forces the mock.
const mode = import.meta.env.VITE_ALMADEL_MOCK
const useMock =
  mode === undefined ? !import.meta.env.PROD : mode !== "0" && mode !== "false"

export const client: AlmadelClient = useMock ? new MockClient() : new HttpClient()

export const isMock = useMock

export type { AlmadelClient } from "./client"
export { ApiError } from "./client"
