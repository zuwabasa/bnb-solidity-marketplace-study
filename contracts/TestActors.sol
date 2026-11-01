// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./Marketplace.sol";

/// @notice Test-only receiver, used to verify failed withdrawal rollback.
contract RejectEther {
    receive() external payable { revert("rejected"); }
}

/// @notice Test-only seller attempts to enter withdraw again from its callback.
contract ReenteringSeller {
    Marketplace public immutable market;
    bool public reentryBlocked;

    constructor(Marketplace market_) { market = market_; }

    function list(uint256 price) external {
        market.listItem("Attack test item", "Local test only", price, 1, bytes32(0));
    }

    function claim() external { market.withdraw(payable(address(this))); }

    receive() external payable {
        try market.withdraw(payable(address(this))) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
    }
}
