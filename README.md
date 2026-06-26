Foundation Mining Pool – Supported Algorithms & Coins

This document lists all hash algorithms currently supported by the pool’s stratum module, along with example cryptocurrencies that use each algorithm.
The pool can mine any coin that implements one of these algorithms, provided a proper configuration is added to configs/pools/.
🔧 Supported Algorithms
Algorithm	Description	Example Coins
sha256d	Double SHA‑256	Bitcoin (BTC), Bitcoin Cash (BCH), Bitcoin SV (BSV), Peercoin (PPC), Namecoin (NMC)
scrypt	Scrypt proof‑of‑work	Litecoin (LTC), Dogecoin (DOGE), Verge (XVG) – classic, Syscoin (SYS)
x11	11‑round hash chain (Blake, BMW, Groestl, etc.)	Dash (DASH), PIVX, Zcoin (XZC) – legacy, CannabisCoin
x13	13‑round hash chain	Ravencoin (RVN) – classic, DeepOnion (ONION), BitcoinZ (BTCZ)
x15	15‑round hash chain	Ravencoin (RVN) – classic, X15 coins
x16r	16‑round random (order changes per block)	Ravencoin (RVN) – current
x16rt	X16R testnet variant	Ravencoin (RVN) – testnet
x16rv2	Second version of X16R	Ravencoin (RVN) – updated
kawpow	Ethash‑based with dynamic memory	Ravencoin (RVN), Ethereum Classic (ETC) – after Thanos upgrade
firopow	Ethash variant with different DAG parameters	Firo (FIRO) – after 2021
equihash	Memory‑hard, uses Equihash 150/5 or 200/9	Zcash (ZEC), Horizen (ZEN), Komodo (KMD), Bitcoin Gold (BTG)
blake	Blake‑256	Blakecoin (BLC), Siacoin (SC) – early
blake2s	Blake2s	Verge (XVG) – blake2s variant, Decred (DCR)
skein	Skein‑512	Skeincoin (SKC), included in Dash’s X11
groestl	Groestl‑512	Groestlcoin (GRS), Vertcoin (VTC) – groestl variant
keccak	Keccak‑256 (SHA‑3 candidate)	Maxcoin (MAX), SmartCash (SMART), Keccak coins
quark	6‑round hashing (Blake, BMW, Groestl, etc.)	Quark (QRK), Atomic (ATOM)
qubit	6‑round hashing	Qubitcoin (Q2C), various
nist5	5‑round NIST hash functions	Einsteinium (EMC2), HTMLCOIN (HTML), Nist5 coins
verthash	Memory‑hard, ASIC‑resistant	Vertcoin (VTC) – current
c11	11‑round hashing	CannabisCoin (CANN), ChainCoin (CHC)
fugue	Fugue‑256	Fuguecoin (FGC), various
ghostrider	Hybrid CPU/GPU algorithm	Raptoreum (RTM)
minotaur	Minotaur algorithm	Minotaur coins
minotaurx	Variant of Minotaur	MinotaurX coins
allium	5‑round hashing with a different mix	Garlicoin (GRLC) – early, Allium coins

    Note: This list is derived from the pool’s algorithms.js module. The pool can be extended to support additional algorithms by adding entries to that file and implementing the corresponding hashing functions (via foundation-multi-hashing or custom bindings).

🪙 Adding a New Coin

To add a coin, create a JSON or JavaScript file in the configs/pools/ directory.
The configuration must specify:

    algorithm – one of the algorithms listed above.

    daemons – RPC connection details (host, port, user, password).

    address – the payout address for the pool (must be valid on the network).

    recipients – fee recipients (addresses and percentages).

    Ports – stratum ports to listen on, with difficulty settings.

    Optional: testnet configuration, p2p settings, etc.

Refer to configs/main/example.js for a full configuration template.
🧪 Testing Your Configuration

After adding a coin, restart the pool:
bash

sudo systemctl restart foundation-server

Check the logs for errors:
bash

sudo journalctl -u foundation-server -f

If the daemon is synced and the configuration is correct, the pool will start serving miners on the specified stratum ports.
📚 Additional Resources

    Foundation Server Repository

    Foundation Stratum Module (optimized version)

    Official Foundation Documentation

📄 License

This project is licensed under the GPL‑2.0 License – see the LICENSE file for details.

Happy Mining! ⛏️
