// egress guard first: smolmix opens its own sockets and fetches, and this
// realm (named `zafu-nym`) may reach only nym's directory and gateways
import '../net/egress-install-lite';
// smolmix, unpacked from @nymproject/mix-tunnel at build time (webpack.config.ts)
import 'nym-smolmix-worker';
