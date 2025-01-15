import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { FhevmInstance } from "fhevmjs/node";
import { ethers } from "hardhat";
import { Address } from "hardhat-deploy/types";

import { ConfidentialERC20Mintable, LP, Pool } from "../types";
import { createInstance } from "./instance";
import { getSigners, initSigners } from "./signers";
import { debug } from "./utils";

describe("LP", function () {
  let lp: LP;
  let lpAddress: Address;
  let liquidityToken: ConfidentialERC20Mintable;
  let liquidityTokenAddress: Address;
  let debtToken: Pool;
  let tokenA: Address;
  let tokenAContract: ConfidentialERC20Mintable;
  let tokenAPool: Address;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  // let user2: SignerWithAddress;
  let fhevm: FhevmInstance;
  let mockOracle: Address;

  const INITIAL_SUPPLY = 1000000000;

  before(async function () {
    await initSigners();
    this.signers = await getSigners();
    owner = this.signers.alice;
    user1 = this.signers.bob;
    fhevm = await createInstance();
  });

  beforeEach(async function () {
    // Deploy mock tokens first
    const TokenFactory = await ethers.getContractFactory("MyConfidentialERC20");
    liquidityToken = await TokenFactory.connect(owner).deploy("Liquidity Token", "LT");
    liquidityTokenAddress = await liquidityToken.getAddress();

    // Deploy token A pool (can be a simple mock contract)
    tokenAContract = await TokenFactory.connect(owner).deploy("TokenA", "TA");
    tokenAContract.waitForDeployment();
    tokenA = await tokenAContract.getAddress();
    const tokenAPoolContract = await TokenFactory.deploy("TokenAPool", "TAP");
    await tokenAPoolContract.waitForDeployment();
    tokenAPool = await tokenAPoolContract.getAddress();

    // Deploy mock oracles
    const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
    const mockOracleContract = await MockOracle.deploy(8, 200000000); // $2.00 with 8 decimals
    mockOracle = await mockOracleContract.getAddress();

    const DebtToken = await ethers.getContractFactory("Pool");
    debtToken = await DebtToken.connect(owner).deploy(liquidityToken, mockOracle, "Debt Token", "DT");

    // Deploy LP contract
    const LP = await ethers.getContractFactory("LP");
    lp = await LP.deploy(await liquidityToken.getAddress(), await debtToken.getAddress(), "LP Token", "LPT");
    lpAddress = await lp.getAddress();

    // Setup initial balances
    await liquidityToken.connect(owner).mint(user1.address, INITIAL_SUPPLY);

    // Add tokenA as supported token
    await debtToken.connect(owner).addSupportedToken(tokenA, mockOracle, tokenAPool);

    // Mint some tokens to user
    await tokenAContract.mint(user1, 1000000000);
    const input = fhevm.createEncryptedInput(tokenA, user1.address);
    input.add64(1000);
    const encryptedAllowanceAmount = await input.encrypt();
    const tx = await tokenAContract
      .connect(user1)
      ["approve(address,bytes32,bytes)"](
        debtToken,
        encryptedAllowanceAmount.handles[0],
        encryptedAllowanceAmount.inputProof,
      );
    await tx.wait();
    const inputAmount = fhevm.createEncryptedInput(await debtToken.getAddress(), user1.address);
    inputAmount.add64(100);
    const encryptedAmount = await inputAmount.encrypt();

    await debtToken
      .connect(user1)
      ["depositToken(address,bytes32,bytes)"](tokenA, encryptedAmount.handles[0], encryptedAmount.inputProof);

    const inputLiquidity = fhevm.createEncryptedInput(liquidityTokenAddress, user1.address);
    inputLiquidity.add64(1000);
    const encryptedLiquidityAllowanceAmount = await inputLiquidity.encrypt();
    const txn = await liquidityToken
      .connect(user1)
      ["approve(address,bytes32,bytes)"](
        lpAddress,
        encryptedLiquidityAllowanceAmount.handles[0],
        encryptedLiquidityAllowanceAmount.inputProof,
      );
    await txn.wait();
  });

  describe("Constructor", function () {
    it("should set the correct liquidity and debt token addresses", async function () {
      expect(await lp.liquidityToken()).to.equal(await liquidityToken.getAddress());
      expect(await lp.debtToken()).to.equal(await debtToken.getAddress());
    });
  });

  describe("addLiquidity", function () {
    const amount = 1000n;

    it("should transfer liquidity tokens and mint LP tokens", async function () {
      const balanceHandleUser = await liquidityToken.balanceOf(user1);
      const balanceUser = await debug.decrypt64(balanceHandleUser);
      expect(balanceUser).to.equal(1000000000);

      const lpAllowanceHandle = await liquidityToken.allowance(user1, lpAddress);
      const lpAllowance = await debug.decrypt64(lpAllowanceHandle);
      expect(lpAllowance).to.equal(1000);

      await lp.connect(user1).addLiquidity(amount);

      const lpBalance = await lp.balanceOf(user1.address);
      expect(await debug.decrypt64(lpBalance)).to.equal(amount);

      const poolBalance = await liquidityToken.balanceOf(lp.getAddress());
      expect(await debug.decrypt64(poolBalance)).to.equal(amount);
    });
  });

  describe("withdrawLiquidity", function () {
    const depositAmount = 1000n;
    const withdrawAmount = 500n;

    beforeEach(async function () {
      await lp.connect(user1).addLiquidity(depositAmount);
    });

    it("should withdraw proportional amount of liquidity tokens", async function () {
      const initialBalance = await liquidityToken.balanceOf(user1.address);

      await lp.connect(user1).withdrawLiquidity(withdrawAmount);

      const finalBalance = await liquidityToken.balanceOf(user1.address);
      expect(await debug.decrypt64(finalBalance)).to.be.gt(await debug.decrypt64(initialBalance));

      const lpBalance = await lp.balanceOf(user1.address);
      expect(await debug.decrypt64(lpBalance)).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("deposit", function () {
    const amount = 100n;
    const depositAmount = 1000n;

    beforeEach(async function () {
      await lp.connect(user1).addLiquidity(depositAmount);
      const inputLiquidity = fhevm.createEncryptedInput(await debtToken.getAddress(), user1.address);
      inputLiquidity.add64(100);
      const encryptedLiquidityAllowanceAmount = await inputLiquidity.encrypt();
      const txn = await debtToken
        .connect(user1)
        ["approve(address,bytes32,bytes)"](
          lpAddress,
          encryptedLiquidityAllowanceAmount.handles[0],
          encryptedLiquidityAllowanceAmount.inputProof,
        );
      await txn.wait();
    });

    it("should burn debt tokens and transfer liquidity tokens", async function () {
      const initialDebtBalance = await debtToken.balanceOf(user1.address);
      const initialLiquidityBalance = await liquidityToken.balanceOf(user1.address);

      const inputAmount = await fhevm.createEncryptedInput(lpAddress, user1.address);
      inputAmount.add64(amount);
      const encryptedInputAmount = await inputAmount.encrypt();
      await lp
        .connect(user1)
        ["deposit(bytes32,bytes)"](encryptedInputAmount.handles[0], encryptedInputAmount.inputProof);

      const finalDebtBalance = await debtToken.balanceOf(user1.address);
      expect(await debug.decrypt64(finalDebtBalance)).to.equal((await debug.decrypt64(initialDebtBalance)) - amount);

      const finalLiquidityBalance = await liquidityToken.balanceOf(user1.address);
      expect(await debug.decrypt64(finalLiquidityBalance)).to.equal(
        (await debug.decrypt64(initialLiquidityBalance)) + amount,
      );
    });
  });
});
