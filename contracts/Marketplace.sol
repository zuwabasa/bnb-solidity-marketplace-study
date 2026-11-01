// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Original study draft for the Rise In marketplace exercise.
library SaleMath {
    function total(uint256 unitPrice, uint256 quantity) internal pure returns (uint256) {
        return unitPrice * quantity;
    }
}

abstract contract ReentrancyGuard {
    uint256 private _guard = 1;
    error ReentrantCall();

    modifier nonReentrant() {
        if (_guard != 1) revert ReentrantCall();
        _guard = 2;
        _;
        _guard = 1;
    }
}

contract Marketplace is ReentrancyGuard {
    using SaleMath for uint256;

    struct Item {
        uint256 id;
        address seller;
        string name;
        string description;
        uint256 price;
        uint256 quantity;
        bytes32 metadataHash;
        bool active;
    }

    struct Purchase {
        uint256 itemId;
        address buyer;
        address seller;
        uint256 quantity;
        uint256 unitPrice;
        uint256 totalPaid;
        uint256 timestamp;
    }

    string public marketplaceName;
    address public immutable deployer;
    uint256 public nextItemId = 1;
    uint256 public totalEscrow;
    mapping(uint256 => Item) private _items;
    mapping(address => uint256[]) private _sellerItems;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(uint256 => uint256) public unitsSold;
    Purchase[] private _purchases;

    error InvalidText();
    error ZeroPrice();
    error ZeroQuantity();
    error ItemNotFound(uint256 itemId);
    error NotSeller(uint256 itemId);
    error InactiveItem(uint256 itemId);
    error OutOfStock(uint256 requested, uint256 available);
    error SelfPurchase();
    error WrongPayment(uint256 expected, uint256 received);
    error NoProceeds();
    error InvalidRecipient();
    error TransferFailed();

    event ItemListed(uint256 indexed itemId, address indexed seller, uint256 price, uint256 quantity);
    event ItemUpdated(uint256 indexed itemId, uint256 price, uint256 quantity);
    event ItemDeleted(uint256 indexed itemId);
    event ItemPurchased(
        uint256 indexed itemId,
        address indexed buyer,
        address indexed seller,
        uint256 quantity,
        uint256 unitPrice,
        uint256 totalPaid
    );
    event ProceedsWithdrawn(address indexed seller, address indexed recipient, uint256 amount);

    constructor(string memory name_) {
        if (bytes(name_).length == 0) revert InvalidText();
        marketplaceName = name_;
        deployer = msg.sender;
    }

    modifier onlySeller(uint256 itemId) {
        _requireItem(itemId);
        if (_items[itemId].seller != msg.sender) revert NotSeller(itemId);
        _;
    }

    function listItem(
        string calldata name,
        string calldata description,
        uint256 price,
        uint256 quantity,
        bytes32 metadataHash
    ) external returns (uint256 itemId) {
        _validateItem(name, price, quantity);
        itemId = nextItemId++;
        _items[itemId] = Item(itemId, msg.sender, name, description, price, quantity, metadataHash, true);
        _sellerItems[msg.sender].push(itemId);
        emit ItemListed(itemId, msg.sender, price, quantity);
    }

    function updateItem(
        uint256 itemId,
        string calldata name,
        string calldata description,
        uint256 price,
        uint256 quantity,
        bytes32 metadataHash
    ) external onlySeller(itemId) {
        Item storage item = _items[itemId];
        if (!item.active) revert InactiveItem(itemId);
        _validateItem(name, price, quantity);
        item.name = name;
        item.description = description;
        item.price = price;
        item.quantity = quantity;
        item.metadataHash = metadataHash;
        emit ItemUpdated(itemId, price, quantity);
    }

    /// @dev Soft deletion preserves IDs and transaction history.
    function deleteItem(uint256 itemId) external onlySeller(itemId) {
        if (!_items[itemId].active) revert InactiveItem(itemId);
        _items[itemId].active = false;
        emit ItemDeleted(itemId);
    }

    function buy(uint256 itemId, uint256 quantity) external payable nonReentrant {
        _requireItem(itemId);
        Item storage item = _items[itemId];
        if (!item.active) revert InactiveItem(itemId);
        if (quantity == 0) revert ZeroQuantity();
        if (quantity > item.quantity) revert OutOfStock(quantity, item.quantity);
        if (msg.sender == item.seller) revert SelfPurchase();
        uint256 totalPaid = item.price.total(quantity);
        if (msg.value != totalPaid) revert WrongPayment(totalPaid, msg.value);

        // No external call during purchase: a seller cannot block all buyers.
        item.quantity -= quantity;
        pendingWithdrawals[item.seller] += totalPaid;
        totalEscrow += totalPaid;
        unitsSold[itemId] += quantity;
        _purchases.push(Purchase(itemId, msg.sender, item.seller, quantity, item.price, totalPaid, block.timestamp));
        emit ItemPurchased(itemId, msg.sender, item.seller, quantity, item.price, totalPaid);
    }

    function withdraw(address payable recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoProceeds();
        // Checks -> effects -> interaction. A reverted transfer restores credits.
        pendingWithdrawals[msg.sender] = 0;
        totalEscrow -= amount;
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit ProceedsWithdrawn(msg.sender, recipient, amount);
    }

    function getItem(uint256 itemId) external view returns (Item memory) {
        _requireItem(itemId);
        return _items[itemId];
    }

    function getSellerItemIds(address seller) external view returns (uint256[] memory) {
        return _sellerItems[seller];
    }

    function purchaseCount() external view returns (uint256) {
        return _purchases.length;
    }

    function getPurchase(uint256 index) external view returns (Purchase memory) {
        return _purchases[index];
    }

    function _requireItem(uint256 itemId) internal view {
        if (_items[itemId].seller == address(0)) revert ItemNotFound(itemId);
    }

    function _validateItem(string calldata name, uint256 price, uint256 quantity) internal pure {
        if (bytes(name).length == 0) revert InvalidText();
        if (price == 0) revert ZeroPrice();
        if (quantity == 0) revert ZeroQuantity();
    }
}
