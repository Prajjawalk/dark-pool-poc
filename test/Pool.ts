import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { FhevmInstance } from "fhevmjs/node";
import { ethers } from "hardhat";
import { Address } from "hardhat-deploy/types";

import { MyConfidentialERC20, Pool } from "../types";
import { createInstance } from "./instance";
import { getSigners, initSigners } from "./signers";
import { debug } from "./utils";

describe("Pool", function () {
  let pool: Address;
  let poolContract: Pool;
  let tokenA: Address;
  let tokenAContract: MyConfidentialERC20;
  let tokenB: Address;
  let tokenBContract: MyConfidentialERC20;
  let tokenAPool: Address;
  let mockOracleA: Address;
  let mockOracleB: Address;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let fhevm: FhevmInstance;

  before(async function () {
    await initSigners();
    this.signers = await getSigners();
    owner = this.signers.alice;
    user = this.signers.bob;
    fhevm = await createInstance();
  });

  beforeEach(async function () {
    // Get signers
    const signers = await getSigners();
    // Deploy mock tokens (ConfidentialERC20)
    const TokenFactory = await ethers.getContractFactory("MyConfidentialERC20");
    tokenAContract = await TokenFactory.connect(signers.alice).deploy("TokenA", "TA");
    tokenAContract.waitForDeployment();
    tokenA = await tokenAContract.getAddress();
    tokenBContract = await TokenFactory.connect(signers.alice).deploy("TokenB", "TB");
    tokenBContract.waitForDeployment();
    tokenB = await tokenBContract.getAddress();

    // Deploy mock oracles
    const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
    const mockOracleAContract = await MockOracle.deploy(8, 100000000); // $1.00 with 8 decimals
    const mockOracleBContract = await MockOracle.deploy(8, 200000000); // $2.00 with 8 decimals
    mockOracleA = await mockOracleAContract.getAddress();
    mockOracleB = await mockOracleBContract.getAddress();

    // Deploy token A pool (can be a simple mock contract)
    const tokenAPoolContract = await TokenFactory.deploy("TokenAPool", "TAP");
    await tokenAPoolContract.waitForDeployment();
    tokenAPool = await tokenAPoolContract.getAddress();

    // Deploy Pool contract
    const Pool = await ethers.getContractFactory("Pool");
    poolContract = await Pool.deploy(tokenB, mockOracleB, "Debt Token", "DT");
    pool = await poolContract.getAddress();

    // Add tokenA as supported token
    await poolContract.addSupportedToken(tokenA, mockOracleA, tokenAPool);

    // Mint some tokens to user
    await tokenAContract.mint(user.address, 1000000000);
    const inputAlice = fhevm.createEncryptedInput(tokenA, user.address);
    inputAlice.add64(1000);
    const encryptedAllowanceAmount = await inputAlice.encrypt();
    const tx = await tokenAContract
      .connect(user)
      ["approve(address,bytes32,bytes)"](
        pool,
        encryptedAllowanceAmount.handles[0],
        encryptedAllowanceAmount.inputProof,
      );
    await tx.wait();
  });

  describe("Constructor & Initial Setup", function () {
    it("Should set correct initial values", async function () {
      expect(await poolContract.dataFeedB()).to.equal(mockOracleB);
      expect(await poolContract.tokenB()).to.equal(tokenB);
      expect(await poolContract.owner()).to.equal(owner);
    });

    it("Should correctly map token to oracle", async function () {
      expect(await poolContract.tokenOracles(tokenA)).to.equal(mockOracleA);
      expect(await poolContract.tokenPools(tokenA)).to.equal(tokenAPool);
    });
  });

  describe("Token Operations", function () {
    it("Should allow deposit of tokenA", async function () {
      const balanceHandleUser = await tokenAContract.balanceOf(user);
      const balanceUser = await debug.decrypt64(balanceHandleUser);
      expect(balanceUser).to.equal(1000000000);

      const poolAllowanceHandle = await tokenAContract.allowance(user, pool);
      const poolAllowance = await debug.decrypt64(poolAllowanceHandle);
      expect(poolAllowance).to.equal(1000);

      const inputAmount = fhevm.createEncryptedInput(pool, user.address);
      inputAmount.add64(100);
      const encryptedAmount = await inputAmount.encrypt();
      await expect(
        await poolContract
          .connect(user)
          ["depositToken(address,bytes32,bytes)"](tokenA, encryptedAmount.handles[0], encryptedAmount.inputProof),
      ).to.not.be.reverted;
    });

    it("Should allow withdrawal of tokenA", async function () {
      // First deposit
      const inputAmount = fhevm.createEncryptedInput(pool, user.address);
      inputAmount.add64(100);
      const encryptedDepositAmount = await inputAmount.encrypt();
      await poolContract
        .connect(user)
        ["depositToken(address,bytes32,bytes)"](
          tokenA,
          encryptedDepositAmount.handles[0],
          encryptedDepositAmount.inputProof,
        );

      // Then withdraw
      const withdrawAmount = fhevm.createEncryptedInput(pool, user.address);
      withdrawAmount.add64(50);
      const encryptedWithdrawAmount = await withdrawAmount.encrypt();
      await expect(
        poolContract
          .connect(user)
          ["withdrawToken(address,bytes32,bytes)"](
            tokenA,
            encryptedWithdrawAmount.handles[0],
            encryptedWithdrawAmount.inputProof,
          ),
      ).to.not.be.reverted;
    });
  });

  describe("Price Calculations", function () {
    it("Should correctly calculate derived price", async function () {
      // Test price calculation by comparing the result of a deposit
      const inputAmount = fhevm.createEncryptedInput(pool, user.address);
      inputAmount.add64(100);
      const encryptedAmount = await inputAmount.encrypt();

      const balanceBefore = 0n;
      // const balanceBeforeDecrypted = await debug.decrypt64(balanceBefore);
      await poolContract
        .connect(user)
        ["depositToken(address,bytes32,bytes)"](tokenA, encryptedAmount.handles[0], encryptedAmount.inputProof);
      const balanceAfter = await poolContract.balanceOf(user);
      const balanceAfterDecrypted = await debug.decrypt64(balanceAfter);

      // Expected amount should be based on price ratio (tokenB/tokenA = 2)
      const expectedDiff = 50;
      expect(balanceAfterDecrypted - balanceBefore).to.equal(expectedDiff);
    });
  });

  describe("Access Control", function () {
    it("Only owner can add supported tokens", async function () {
      const newToken = ethers.Wallet.createRandom().address;
      const newOracle = ethers.Wallet.createRandom().address;
      const newPool = ethers.Wallet.createRandom().address;

      await expect(
        poolContract.connect(user).addSupportedToken(newToken, newOracle, newPool),
      ).to.be.revertedWithCustomError(poolContract, "OwnableUnauthorizedAccount");

      await expect(poolContract.connect(owner).addSupportedToken(newToken, newOracle, newPool)).to.not.be.reverted;
    });
  });
});
