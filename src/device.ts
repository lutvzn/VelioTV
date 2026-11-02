// The settings for the TV this build targets. The build points `#device` at
// devices/<TARGET_DEVICE>; see devices/deviceConfigPlugin.ts.
import { config } from "#device";

export { config };

// Starts when the app loads, so the TV registers its remote keys early.
export const device = config.initialize();
