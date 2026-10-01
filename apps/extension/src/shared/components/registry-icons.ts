/**
 * Installs the bundled-icon resolver for `AssetIcon`/`RegistryIcon` with the
 * registry icons zafu actually ships: a curated set of majors (native assets,
 * major stablecoins, major L1/L2s and their liquid-staked variants) plus the
 * penumbra registry's own rpc/frontend/validator images, all downscaled to
 * the sizes they are displayed at. Generated from
 * assets/registry-icons/manifest.json - regenerate both together if the
 * curated set changes.
 *
 * Imported once, before the first render (entry/popup-root.tsx,
 * entry/page-root.tsx); every AssetIcon/RegistryIcon benefits for free.
 *
 * The registry carries thousands more assets than this build bundles icons
 * for - that is "unknown", not an error: AssetIcon/RegistryIcon fall back to
 * the Identicon monogram rather than ever reaching raw.githubusercontent.com.
 */

import { setBundledIconResolver } from '@repo/ui/components/ui/asset-icon/bundled-icons';

import aave from '../../assets/registry-icons/aave.svg';
import allbtc from '../../assets/registry-icons/allbtc.png';
import alldot from '../../assets/registry-icons/alldot.png';
import alllink from '../../assets/registry-icons/alllink.png';
import alluni from '../../assets/registry-icons/alluni.svg';
import apt from '../../assets/registry-icons/apt.svg';
import atom from '../../assets/registry-icons/atom.png';
import axlwbtc from '../../assets/registry-icons/axlwbtc.png';
import bnb from '../../assets/registry-icons/bnb.png';
import dai from '../../assets/registry-icons/dai.png';
import doge from '../../assets/registry-icons/doge.png';
import dydx from '../../assets/registry-icons/dydx.png';
import fil from '../../assets/registry-icons/fil.png';
import frontendZechub from '../../assets/registry-icons/frontend-zechub.png';
import icp from '../../assets/registry-icons/icp.png';
import inj from '../../assets/registry-icons/inj.png';
import kava from '../../assets/registry-icons/kava.png';
import ltc from '../../assets/registry-icons/ltc.png';
import milktia from '../../assets/registry-icons/milktia.png';
import mkr from '../../assets/registry-icons/mkr.svg';
import ntrn from '../../assets/registry-icons/ntrn.png';
import osmo from '../../assets/registry-icons/osmo.png';
import pol from '../../assets/registry-icons/pol.png';
import rpcGhostinnet from '../../assets/registry-icons/rpc-ghostinnet.png';
import sol from '../../assets/registry-icons/sol.png';
import statom from '../../assets/registry-icons/statom.png';
import stdydx from '../../assets/registry-icons/stdydx.png';
import stinj from '../../assets/registry-icons/stinj.png';
import stosmo from '../../assets/registry-icons/stosmo.png';
import sttia from '../../assets/registry-icons/sttia.png';
import sui from '../../assets/registry-icons/sui.svg';
import tia from '../../assets/registry-icons/tia.png';
import ton from '../../assets/registry-icons/ton.png';
import trx from '../../assets/registry-icons/trx.png';
import um from '../../assets/registry-icons/um.svg';
import usdc from '../../assets/registry-icons/usdc.png';
import usdn from '../../assets/registry-icons/usdn.png';
import usdt from '../../assets/registry-icons/usdt.png';
import validatorAntumbraNet from '../../assets/registry-icons/validator-antumbra-net.png';
import validatorBryanlabs from '../../assets/registry-icons/validator-bryanlabs.png';
import validatorGhostinnet from '../../assets/registry-icons/validator-ghostinnet.png';
import validatorMathnodes from '../../assets/registry-icons/validator-mathnodes.png';
import validatorOriginstake from '../../assets/registry-icons/validator-originstake.png';
import validatorPathrocknetwork from '../../assets/registry-icons/validator-pathrocknetwork.png';
import validatorRotkoNet from '../../assets/registry-icons/validator-rotko-net.png';
import validatorSilent from '../../assets/registry-icons/validator-silent.png';
import validatorTessellated from '../../assets/registry-icons/validator-tessellated.png';
import validatorValidatus from '../../assets/registry-icons/validator-validatus.png';
import walletPrax from '../../assets/registry-icons/wallet-prax.png';
import weth from '../../assets/registry-icons/weth.png';
import xrp from '../../assets/registry-icons/xrp.png';
import zec from '../../assets/registry-icons/zec.png';

const BY_URL: Record<string, string> = {
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/aave.svg':
    aave,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/bitcoin/images/btc.png':
    allbtc,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/polkadot/images/dot.png':
    alldot,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/link.png':
    alllink,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/uni.svg':
    alluni,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/aptos/images/aptos.svg':
    apt,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.png': atom,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/wbtc.png':
    axlwbtc,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/binancesmartchain/images/bnb.png':
    bnb,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/axelar/images/dai.png': dai,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/dogecoin/images/doge.png':
    doge,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/dydx/images/dydx.png': dydx,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/filecoin/images/fil.png':
    fil,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/zec-hub.png': frontendZechub,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/internetcomputer/images/icp.png':
    icp,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/injective/images/inj.png': inj,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/kava/images/kava.png': kava,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/litecoin/images/ltc.png':
    ltc,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/milktia.png':
    milktia,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/mkr.svg':
    mkr,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/neutron/images/ntrn.png': ntrn,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.png': osmo,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/polygon/images/matic-purple.png':
    pol,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/ghostinnet.png': rpcGhostinnet,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/solana/images/sol_circle.png':
    sol,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/statom.png': statom,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/stdydx.png': stdydx,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/stinj.png': stinj,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/stosmo.png': stosmo,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/sttia.png': sttia,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/sui/images/sui.svg':
    sui,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/celestia/images/celestia.png':
    tia,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ton/images/ton.png':
    ton,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/tron/images/trx.png':
    trx,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/um.svg': um,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.png':
    usdc,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/noble/images/USDN.png': usdn,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdt.png':
    usdt,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1ktcv24rwkp69mc6hf5g7kwpwrevy6mrzdsg07nq3za6z4fp72cyqf4aw3d.png':
    validatorAntumbraNet,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid19qcxdmkpry2zda9htt2wprpk32yc9nwjgmc0xvqwm8qz5afk6upsmg55hh.png':
    validatorBryanlabs,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid10n2srs5257a6nxq9x3fhcsqyc0wh8q2lp7f80qd7wlmzdm6znypse23mmh.png':
    validatorGhostinnet,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1jf8tmgqaar2xdrhspmmuwyd6jt6hedjh0gz32pz4vwrmh93tvsyswth2sf.png':
    validatorMathnodes,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1he9sez9r2yzc8dekh5w7vqqz6r5c557s8jjchmu3879e9lzn4g9q57k04c.png':
    validatorOriginstake,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1gq4j0hh6grl6d7apwg8z5qj97q7uhkeq0tp9qr66xe03cyrjkyrskp7s6v.png':
    validatorPathrocknetwork,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1ar6hyxmvy0em86nclqgxc4qlauj9ct747g4dsx8tn6wthg9nuvrq099640.png':
    validatorRotkoNet,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid19jqf35xytm4ht9f8awtad9wxmfky0tjygug8390cewyqjwmyucqqkkrc9r.png':
    validatorSilent,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1mr4j6nh3za3wjptjr2uj2ssr3fg0gxxqgqg9vgjl7luqa3qur5zs3fj5w6.png':
    validatorTessellated,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/validators/penumbravalid1q2eu6p33ne58aq0xh2ramsftmxqtqzlzwpa6uy8tgygje39mzypsq6nuyw.png':
    validatorValidatus,
  'https://raw.githubusercontent.com/penumbrafi/registry/main/images/penumbra-favicon.png':
    walletPrax,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/eth-white.png':
    weth,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/xrpl/images/xrp.png':
    xrp,
  'https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/zcash/images/zec.png':
    zec,
};

export const installRegistryIcons = (): void => {
  setBundledIconResolver((url: string) => BY_URL[url]);
};
