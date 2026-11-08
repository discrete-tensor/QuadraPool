// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IQFPool {
    function claim(uint256 projectId) external;
}

/// @dev Test-only attacker: tries to re-enter claim() when receiving ETH.
contract ReentrantRecipient {
    IQFPool public immutable pool;
    uint256 public targetId;

    constructor(address _pool) {
        pool = IQFPool(_pool);
    }

    function attack(uint256 projectId) external {
        targetId = projectId;
        pool.claim(projectId);
    }

    receive() external payable {
        pool.claim(targetId); // reverts with ReentrancyGuardReentrantCall
    }
}
