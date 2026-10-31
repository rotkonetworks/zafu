// SPDX-License-Identifier: MIT
// Reproduce: pnpm build:drip (solc-js 0.8.38, optimizer on, 200 runs, evmVersion paris).
// Stateless and ownerless: it forwards the eth it is called with and logs who
// sent it, so the status page can read the sponsor's drips with eth_getLogs.
pragma solidity 0.8.38;

contract Drip {
    event Dripped(address indexed from, address indexed to, uint256 amount);

    function drip(address payable to) external payable {
        (bool ok, ) = to.call{value: msg.value}("");
        require(ok, "send failed");
        emit Dripped(msg.sender, to, msg.value);
    }
}
