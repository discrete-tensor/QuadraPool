// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract QuadraticFundingPool is Ownable, ReentrancyGuard {

    struct Project {
        string name;
        string description;
        address payable recipient;
        uint256 totalContributed;
        uint256 sumSqrt;
        uint256 contributorCount;
        uint256 matchAmount;
        bool claimed;
    }

    enum Status { Open, Finalized, Cancelled }

    uint256 public constant MAX_PROJECTS = 20;

    string public roundName;
    uint256 public immutable endTime;
    uint256 public immutable minContribution;

    Status public status;
    bool public allowlistEnabled;
    uint256 public matchingPool;
    uint256 public totalWeight;
    uint256 public matchingDistributed;
    uint256 public sponsorDeposits;
    uint256 public dust;

    Project[] private _projects;
    mapping(uint256 => mapping(address => uint256)) public contributionOf;
    mapping(address => bool) public isAllowlisted;
    mapping(address => uint256) public sponsorAmount;

    event ProjectAdded(uint256 indexed projectId, string name, address recipient);
    event MatchingFunded(address indexed sponsor, uint256 amount);
    event Contributed(uint256 indexed projectId, address indexed contributor, uint256 amount, uint256 newSumSqrt);
    event AllowlistUpdated(address indexed account, bool allowed);
    event AllowlistToggled(bool enabled);
    event RoundFinalized(uint256 totalWeight, uint256 matchingDistributed, uint256 dust);
    event Claimed(uint256 indexed projectId, address indexed recipient, uint256 amount);
    event RoundCancelled();
    event Refunded(uint256 indexed projectId, address indexed contributor, uint256 amount);
    event SponsorRefunded(address indexed sponsor, uint256 amount);

    error RoundNotOpen();
    error RoundStillRunning();
    error RoundEnded();
    error NotFinalized();
    error NotCancelled();
    error InvalidProject();
    error TooManyProjects();
    error ZeroAddress();
    error BelowMinimum();
    error NotAllowlisted();
    error NotRecipient();
    error AlreadyClaimed();
    error NothingToRefund();
    error TransferFailed();

    constructor(
        string memory _roundName,
        uint256 _duration,
        uint256 _minContribution,
        bool _allowlist
    ) Ownable(msg.sender) {
        roundName = _roundName;
        endTime = block.timestamp + _duration;
        minContribution = _minContribution;
        allowlistEnabled = _allowlist;
        status = Status.Open;
    }

    modifier whileOpen() {
        if (status != Status.Open) revert RoundNotOpen();
        if (block.timestamp >= endTime) revert RoundEnded();
        _;
    }

    modifier validProject(uint256 projectId) {
        if (projectId >= _projects.length) revert InvalidProject();
        _;
    }

    function addProject(string calldata name, string calldata description, address payable recipient)
        external
        onlyOwner
        whileOpen
        returns (uint256 projectId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (_projects.length >= MAX_PROJECTS) revert TooManyProjects();
        projectId = _projects.length;
        Project storage p = _projects.push();
        p.name = name;
        p.description = description;
        p.recipient = recipient;
        emit ProjectAdded(projectId, name, recipient);
    }

    function setAllowlist(address[] calldata accounts, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            isAllowlisted[accounts[i]] = allowed;
            emit AllowlistUpdated(accounts[i], allowed);
        }
    }

    function setAllowlistEnabled(bool enabled) external onlyOwner whileOpen {
        allowlistEnabled = enabled;
        emit AllowlistToggled(enabled);
    }

    function cancelRound() external onlyOwner {
        if (status != Status.Open) revert RoundNotOpen();
        status = Status.Cancelled;
        emit RoundCancelled();
    }

    function fundMatchingPool() external payable whileOpen {
        if (msg.value == 0) revert BelowMinimum();
        matchingPool += msg.value;
        sponsorDeposits += msg.value;
        sponsorAmount[msg.sender] += msg.value;
        emit MatchingFunded(msg.sender, msg.value);
    }

    function contribute(uint256 projectId) external payable whileOpen validProject(projectId) {
        if (msg.value < minContribution) revert BelowMinimum();
        if (allowlistEnabled && !isAllowlisted[msg.sender]) revert NotAllowlisted();

        Project storage p = _projects[projectId];
        uint256 oldAmount = contributionOf[projectId][msg.sender];
        uint256 newAmount = oldAmount + msg.value;

        if (oldAmount == 0) p.contributorCount += 1;
        p.sumSqrt = p.sumSqrt + Math.sqrt(newAmount) - Math.sqrt(oldAmount);
        p.totalContributed += msg.value;
        contributionOf[projectId][msg.sender] = newAmount;

        emit Contributed(projectId, msg.sender, msg.value, p.sumSqrt);
    }

    function finalize() external {
        if (status != Status.Open) revert RoundNotOpen();
        if (block.timestamp < endTime) revert RoundStillRunning();

        uint256 n = _projects.length;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            total += _weight(_projects[i]);
        }
        totalWeight = total;

        uint256 distributed;
        if (total > 0) {
            for (uint256 i = 0; i < n; i++) {
                uint256 m = Math.mulDiv(matchingPool, _weight(_projects[i]), total);
                _projects[i].matchAmount = m;
                distributed += m;
            }
        } else {
            uint256 raised;
            for (uint256 i = 0; i < n; i++) raised += _projects[i].totalContributed;
            if (raised > 0) {
                for (uint256 i = 0; i < n; i++) {
                    uint256 m = Math.mulDiv(matchingPool, _projects[i].totalContributed, raised);
                    _projects[i].matchAmount = m;
                    distributed += m;
                }
            }
        }
        matchingDistributed = distributed;
        status = Status.Finalized;

        dust = matchingPool - distributed;
        emit RoundFinalized(total, distributed, dust);
    }

    function withdrawDust() external onlyOwner nonReentrant {
        if (status != Status.Finalized) revert NotFinalized();
        uint256 amount = dust;
        if (amount == 0) revert NothingToRefund();
        dust = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function claim(uint256 projectId) external nonReentrant validProject(projectId) {
        if (status != Status.Finalized) revert NotFinalized();
        Project storage p = _projects[projectId];
        if (msg.sender != p.recipient) revert NotRecipient();
        if (p.claimed) revert AlreadyClaimed();

        p.claimed = true;
        uint256 amount = p.totalContributed + p.matchAmount;
        emit Claimed(projectId, p.recipient, amount);

        (bool ok, ) = p.recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function refund(uint256 projectId) external nonReentrant validProject(projectId) {
        if (status != Status.Cancelled) revert NotCancelled();
        uint256 amount = contributionOf[projectId][msg.sender];
        if (amount == 0) revert NothingToRefund();

        contributionOf[projectId][msg.sender] = 0;
        _projects[projectId].totalContributed -= amount;
        emit Refunded(projectId, msg.sender, amount);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function refundSponsor() external nonReentrant {
        if (status != Status.Cancelled) revert NotCancelled();
        uint256 amount = sponsorAmount[msg.sender];
        if (amount == 0) revert NothingToRefund();

        sponsorAmount[msg.sender] = 0;
        matchingPool -= amount;
        emit SponsorRefunded(msg.sender, amount);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function projectCount() external view returns (uint256) {
        return _projects.length;
    }

    function getProject(uint256 projectId) external view validProject(projectId) returns (Project memory) {
        return _projects[projectId];
    }

    function getAllProjects() external view returns (Project[] memory) {
        return _projects;
    }

    function weightOf(uint256 projectId) external view validProject(projectId) returns (uint256) {
        return _weight(_projects[projectId]);
    }

    function estimatedMatch(uint256 projectId) public view validProject(projectId) returns (uint256) {
        if (status == Status.Finalized) return _projects[projectId].matchAmount;
        uint256 total = _currentTotalWeight();
        if (total == 0) return 0;
        return Math.mulDiv(matchingPool, _weight(_projects[projectId]), total);
    }

    function previewContribution(uint256 projectId, address contributor, uint256 amount)
        external
        view
        validProject(projectId)
        returns (uint256 matchBefore, uint256 matchAfter)
    {
        matchBefore = estimatedMatch(projectId);
        Project storage p = _projects[projectId];
        uint256 oldAmt = contributionOf[projectId][contributor];
        uint256 newSumSqrt = p.sumSqrt + Math.sqrt(oldAmt + amount) - Math.sqrt(oldAmt);
        uint256 newTotal = p.totalContributed + amount;
        uint256 newW = _weightFrom(newSumSqrt, newTotal);
        uint256 total = _currentTotalWeight() - _weight(p) + newW;
        matchAfter = total == 0 ? 0 : Math.mulDiv(matchingPool, newW, total);
    }

    function _currentTotalWeight() internal view returns (uint256 total) {
        for (uint256 i = 0; i < _projects.length; i++) {
            total += _weight(_projects[i]);
        }
    }

    function _weight(Project storage p) internal view returns (uint256) {
        return _weightFrom(p.sumSqrt, p.totalContributed);
    }

    function _weightFrom(uint256 sumSqrt, uint256 total) internal pure returns (uint256) {
        uint256 sq = sumSqrt * sumSqrt;
        return sq > total ? sq - total : 0;
    }
}
