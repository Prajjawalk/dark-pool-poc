// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "fhevm/lib/TFHE.sol";
import "fhevm-contracts/contracts/token/ERC20/IConfidentialERC20.sol";
import "fhevm/config/ZamaFHEVMConfig.sol";
import "./LP.sol";

contract Batcher is SepoliaZamaFHEVMConfig {
    uint8 batchsize;
    uint256 counter;
    address debtToken;
    address liquidityToken;
    address lp;
    euint64 batchAmount;

    struct Intent {
        address user;
        euint64 amount;
    }

    Intent[] intents;

    constructor (uint8 _batchsize, address _debtToken, address _liquidityToken, address _lp) {
        batchsize = _batchsize;
        debtToken = _debtToken;
        lp = _lp;
        liquidityToken = _liquidityToken;
    }

    function deposit(einput encryptedAmount, bytes memory inputProof) public returns (bool) {
        deposit(TFHE.asEuint64(encryptedAmount, inputProof));
        return true;
    }

    function deposit(euint64 encryptedAmount) public returns(bool) {
        counter += 1;

        if (counter % batchsize == 0) {
            TFHE.allowTransient(batchAmount, debtToken);
            IConfidentialERC20(debtToken).approve(lp, batchAmount);

            TFHE.allowTransient(batchAmount, lp);
            require(LP(lp).deposit(batchAmount));
            batchAmount = TFHE.asEuint64(0);

            for (uint256 i = 0; i < intents.length; i++) {
                TFHE.allowTransient(intents[i].amount, liquidityToken);
                require(IConfidentialERC20(liquidityToken).transfer(intents[i].user, intents[i].amount));
                delete intents[i];
            }
        }

        TFHE.allowThis(encryptedAmount);
        Intent memory newIntent = Intent(msg.sender, encryptedAmount);
        intents.push(newIntent);
        batchAmount = TFHE.add(batchAmount, encryptedAmount);
        TFHE.allowThis(batchAmount);

        TFHE.allowTransient(encryptedAmount, debtToken);
        IConfidentialERC20(debtToken).transferFrom(
            msg.sender, address(this),
            encryptedAmount
        );

        return true;
    }
}
