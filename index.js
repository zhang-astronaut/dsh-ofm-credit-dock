/**
 * Host half of the OFM credit dock bundle.
 *
 * The whole feature is browser-side: the dock reads the Our Free Model plugin's
 * own `/api/channel-pack` RPC and the session list's model-selection projection.
 * There is no Host service to provide, so this half only exists to give the
 * bundle a Plugin Manager row.
 */
export function apply() {}
