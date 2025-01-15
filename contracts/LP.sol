// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "fhevm/lib/TFHE.sol";
import "fhevm-contracts/contracts/token/ERC20/ConfidentialERC20.sol";
import "fhevm-contracts/contracts/token/ERC20/IConfidentialERC20.sol";
import "fhevm/config/ZamaFHEVMConfig.sol";
import "./DebtERC20.sol";

contract LP is SepoliaZamaFHEVMConfig, ConfidentialERC20 {
    address public liquidityToken;
    address public debtToken;

    constructor(
        address _liquidityToken,
        address _debtToken,
        string memory name_,
        string memory symbol_
    ) ConfidentialERC20(name_, symbol_) {
        liquidityToken = _liquidityToken;
        debtToken = _debtToken;
    }

    function addLiquidity(uint64 amount) public virtual returns (bool) {
        euint64 encryptedAmount = TFHE.asEuint64(amount);
        TFHE.allowTransient(encryptedAmount, liquidityToken);
        require(IConfidentialERC20(liquidityToken).transferFrom(msg.sender, address(this), encryptedAmount));
        _unsafeMint(msg.sender, amount);
        _totalSupply += amount;
        return true;
    }

    function withdrawLiquidity(uint64 amount) public {
        euint64 balance = IConfidentialERC20(liquidityToken).balanceOf(address(this));
        euint64 liquidityAmount = TFHE.div(TFHE.mul(balance, amount), _totalSupply);

        TFHE.allowTransient(liquidityAmount, liquidityToken);
        require(IConfidentialERC20(liquidityToken).transfer(msg.sender, liquidityAmount));
        _unsafeBurn(msg.sender, amount);
    }

    function deposit(einput encryptedAmount, bytes memory inputProof) public returns (bool) {
        deposit(TFHE.asEuint64(encryptedAmount, inputProof));
        return true;
    }

    function deposit(euint64 amount) public returns (bool) {
        TFHE.allowTransient(amount, debtToken);
        DebtERC20(debtToken).burnFrom(msg.sender, amount);

        TFHE.allowTransient(amount, liquidityToken);
        require(IConfidentialERC20(liquidityToken).transfer(msg.sender, amount));
        return true;
    }

    function _unsafeBurn(address account, uint64 amount) internal {
        euint64 newBalanceAccount = TFHE.sub(_balances[account], amount);
        _balances[account] = newBalanceAccount;
        _totalSupply = _totalSupply - amount;
        TFHE.allowThis(newBalanceAccount);
        TFHE.allow(newBalanceAccount, account);
        emit Transfer(account, address(0), _PLACEHOLDER);
    }
}
