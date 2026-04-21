/**
 * `@toncast/tx-sdk/jetton` subpath entry — jetton builders and route discovery.
 *
 * Importing from this subpath requires `@ston-fi/sdk` to be installed (it is
 * an optional peer dependency on the package root). TON-only integrations
 * should import from `@toncast/tx-sdk` instead and never reference this
 * module so that bundlers can drop `@ston-fi/sdk` from the graph.
 */

export {
  type BuildJettonBetTxParams,
  buildJettonBetTx,
} from "../builders/jetton.js";
export {
  type DiscoveredRoute,
  type DiscoverRouteInput,
  discoverRoute,
  type SwapSimulation,
} from "../routing/discover.js";
