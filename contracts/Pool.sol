// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "fhevm/lib/TFHE.sol";
import "fhevm-contracts/contracts/token/ERC20/ConfidentialERC20.sol";
import "./DebtERC20.sol";
import "fhevm-contracts/contracts/token/ERC20/IConfidentialERC20.sol";
import "fhevm/config/ZamaFHEVMConfig.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Pool is SepoliaZamaFHEVMConfig, DebtERC20, Ownable {
    euint256 counter;
    address public dataFeedB;
    address public tokenB;

    mapping(address => address) public tokenOracles;
    mapping(address => address) public tokenPools;

    constructor(
        address _tokenB,
        address _oracleB,
        string memory name_,
        string memory symbol_
    ) DebtERC20(name_, symbol_) Ownable(msg.sender) {
        dataFeedB = _oracleB;
        tokenB = _tokenB;
    }

    function getLatestPrice(address tokenA) internal view returns (int256 price) {
        price = getDerivedPrice(tokenOracles[tokenA], dataFeedB, 8);
    }

    /**
     * Deposit token to receive debt token
     * @param tokenA input token address
     * @param encryptedAmount amount of input token
     * @param inputProof input proof
     */
    function depositToken(
        address tokenA,
        einput encryptedAmount,
        bytes calldata inputProof
    ) public virtual returns (bool) {
        depositToken(tokenA, TFHE.asEuint64(encryptedAmount, inputProof));
        return true;
    }

    function depositToken(address tokenA, euint64 amount) public virtual returns (bool) {
        require(tokenOracles[tokenA] != address(0));
        require(tokenPools[tokenA] != address(0));
        counter = TFHE.add(counter, 1);
        TFHE.allowThis(counter);

        // Fetch price of token B relative to token A
        int256 price = getLatestPrice(tokenA);

        TFHE.allowTransient(amount, tokenA);

        require(IConfidentialERC20(tokenA).transferFrom(msg.sender, address(this), amount));

        // Modify amount based on the price ratio
        amount = TFHE.div(TFHE.mul(amount, TFHE.asEuint64(uint256(price))), 10 ** 8);
        _unsafeMint(msg.sender, amount);

        euint64 balance = IConfidentialERC20(tokenA).balanceOf(address(this));
        euint64 transferAmount = TFHE.select(TFHE.eq(TFHE.rem(counter, 11), 0), balance, TFHE.asEuint64(0));

        TFHE.allowTransient(transferAmount, tokenA);
        require(IConfidentialERC20(tokenA).transfer(tokenPools[tokenA], transferAmount));
        return true;
    }

    /**
     * Withdraw tokenA from dept token.
     * This is a fallback option to the user to get back initial supplied token
     * incase there is insufficient liquidity of tokenB in LP pool
     * @param tokenA the output token address
     * @param encryptedAmount input amount of debt token
     * @param inputProof input proof
     */
    function withdrawToken(address tokenA, einput encryptedAmount, bytes calldata inputProof) public returns (bool) {
        withdrawToken(tokenA, TFHE.asEuint64(encryptedAmount, inputProof));
        return true;
    }

    function withdrawToken(address tokenA, euint64 amount) public returns (bool) {
        int256 price = getDerivedPrice(dataFeedB, tokenOracles[tokenA], 8);
        burn(amount);

        // Modify amount based on the price ratio
        amount = TFHE.div(TFHE.mul(amount, TFHE.asEuint64(uint256(price))), 10 ** 8);
        TFHE.allowTransient(amount, tokenA);
        IConfidentialERC20(tokenA).transfer(msg.sender, amount);
        return true;
    }

    /**
     * Add supported token to the exchange
     * @param token token address
     * @param oracle asset price oracle in ASSET/USD
     */
    function addSupportedToken(address token, address oracle, address pool) external onlyOwner {
        tokenOracles[token] = oracle;
        tokenPools[token] = pool;
    }

    function getDerivedPrice(address _base, address _quote, uint8 _decimals) internal view returns (int256) {
        require(_decimals > uint8(0) && _decimals <= uint8(18), "Invalid _decimals");
        int256 decimals = int256(10 ** uint256(_decimals));
        (, int256 basePrice, , , ) = AggregatorV3Interface(_base).latestRoundData();
        uint8 baseDecimals = AggregatorV3Interface(_base).decimals();
        basePrice = scalePrice(basePrice, baseDecimals, _decimals);

        (, int256 quotePrice, , , ) = AggregatorV3Interface(_quote).latestRoundData();
        uint8 quoteDecimals = AggregatorV3Interface(_quote).decimals();
        quotePrice = scalePrice(quotePrice, quoteDecimals, _decimals);

        return (basePrice * decimals) / quotePrice;
    }

    function scalePrice(int256 _price, uint8 _priceDecimals, uint8 _decimals) internal pure returns (int256) {
        if (_priceDecimals < _decimals) {
            return _price * int256(10 ** uint256(_decimals - _priceDecimals));
        } else if (_priceDecimals > _decimals) {
            return _price / int256(10 ** uint256(_priceDecimals - _decimals));
        }
        return _price;
    }
}
