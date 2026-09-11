import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Must run before anything imports @testing-library/react (which binds `screen`
// to document.body at module-eval time).
GlobalRegistrator.register()
