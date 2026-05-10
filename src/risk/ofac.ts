import type { Hex } from "viem"

// Demo set: a few well-known OFAC-sanctioned addresses (Tornado Cash mixers,
// North Korean lazarus addresses, etc.). Production should pull from
// Chainalysis Sanctions Oracle on Ethereum mainnet (0x40C57923924B5c5c5455c48D93317139ADDaC8fb)
// or TRM Labs / OFAC SDN list.
const SANCTIONED = new Set<string>(
  [
    "0x8589427373D6D84E98730D7795D8f6f8731FDA16", // Tornado Cash 0.1 ETH
    "0x722122dF12D4e14e13Ac3b6895a86e84145b6967", // Tornado Cash router
    "0xDD4c48C0B24039969fC16D1cdF626eaB821d3384", // Tornado Cash 10 ETH
    "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b", // Tornado Cash 100 ETH
    "0xd96f2B1c14Db8458374d9Aca76E26c3D18364307", // Tornado Cash 0.1 ETH
    "0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D", // Tornado Cash 1 ETH
  ].map((a) => a.toLowerCase()),
)

export function isSanctioned(address: Hex): boolean {
  return SANCTIONED.has(address.toLowerCase())
}
