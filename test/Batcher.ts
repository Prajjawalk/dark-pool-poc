import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { FhevmInstance } from "fhevmjs/node";
import { ethers } from "hardhat";
import { Address } from "hardhat-deploy/types";

import { Batcher, LP, MyConfidentialERC20, Pool } from "../types";
import { createInstance } from "./instance";
import { getSigners, initSigners } from "./signers";
import { debug } from "./utils";

describe("Batcher", function () {
  let debtToken: Pool;
  let debtTokenAddress: Address;
  let liquidityToken: MyConfidentialERC20;
  let liquidityTokenAddress: Address;
  let lp: LP;
  let lpAddress: Address;
  let mockOracle: Address;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let fhevm: FhevmInstance;
  let batcher: Batcher;
  const BATCH_SIZE = 2;

  before(async function () {
    await initSigners();
    this.signers = await getSigners();
    alice = this.signers.alice;
    bob = this.signers.bob;
    fhevm = await createInstance();
  });

  beforeEach(async function () {
    // Deploy tokens
    const TokenFactory = await ethers.getContractFactory("MyConfidentialERC20");

    // Deploy token A
    const tokenAContract = await TokenFactory.connect(alice).deploy("TokenA", "TA");
    const tokenA = await tokenAContract.getAddress();

    // Deploy LP for input token
    const tokenAPoolContract = await TokenFactory.deploy("TokenAPool", "TAP");
    await tokenAPoolContract.waitForDeployment();
    const tokenAPool = await tokenAPoolContract.getAddress();

    // Deploy mock oracles
    const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
    const mockOracleContract = await MockOracle.deploy(8, 200000000); // $2.00 with 8 decimals
    mockOracle = await mockOracleContract.getAddress();

    // Deploy liquidity token
    liquidityToken = await TokenFactory.connect(alice).deploy("Liquidity Token", "LIQ");
    liquidityTokenAddress = await liquidityToken.getAddress();

    // Deploy pool
    const DebtToken = await ethers.getContractFactory("Pool");
    debtToken = await DebtToken.connect(alice).deploy(liquidityTokenAddress, mockOracle, "Debt Token", "DT");
    debtTokenAddress = await debtToken.getAddress();

    // Add tokenA as supported token
    await debtToken.connect(alice).addSupportedToken(tokenA, mockOracle, tokenAPool);

    // Deploy LP contract
    const LP = await ethers.getContractFactory("LP");
    lp = await LP.deploy(liquidityTokenAddress, debtTokenAddress, "LP Token", "LPT");
    lpAddress = await lp.getAddress();

    // Add liquidity to LP pool
    await liquidityToken.mint(alice.address, 100);
    const inputLiquidity = await fhevm.createEncryptedInput(liquidityTokenAddress, alice.address).add64(100).encrypt();
    const txn = await liquidityToken
      .connect(alice)
      ["approve(address,bytes32,bytes)"](lpAddress, inputLiquidity.handles[0], inputLiquidity.inputProof);
    await txn.wait();
    await lp.connect(alice).addLiquidity(100);

    // Mint some tokens to alice
    await tokenAContract.mint(alice, 1000000000);
    const input = fhevm.createEncryptedInput(tokenA, alice.address);
    input.add64(1000);
    const encryptedAllowanceAmount = await input.encrypt();
    const tx = await tokenAContract
      .connect(alice)
      ["approve(address,bytes32,bytes)"](
        debtTokenAddress,
        encryptedAllowanceAmount.handles[0],
        encryptedAllowanceAmount.inputProof,
      );
    await tx.wait();
    const inputAmount = fhevm.createEncryptedInput(debtTokenAddress, alice.address);
    inputAmount.add64(1000);
    const encryptedAmount = await inputAmount.encrypt();

    await debtToken
      .connect(alice)
      ["depositToken(address,bytes32,bytes)"](tokenA, encryptedAmount.handles[0], encryptedAmount.inputProof);

    // Mint some tokens to bob
    await tokenAContract.mint(bob.address, 1000000000);
    const inputB = fhevm.createEncryptedInput(tokenA, bob.address);
    inputB.add64(1000);
    const encryptedAllowanceAmountB = await inputB.encrypt();
    const txB = await tokenAContract
      .connect(bob)
      ["approve(address,bytes32,bytes)"](
        debtTokenAddress,
        encryptedAllowanceAmountB.handles[0],
        encryptedAllowanceAmountB.inputProof,
      );
    await txB.wait();
    const inputAmountB = fhevm.createEncryptedInput(debtTokenAddress, bob.address);
    inputAmountB.add64(1000);
    const encryptedAmountB = await inputAmountB.encrypt();

    await debtToken
      .connect(bob)
      ["depositToken(address,bytes32,bytes)"](tokenA, encryptedAmountB.handles[0], encryptedAmountB.inputProof);

    // Deploy Batcher
    const Batcher = await ethers.getContractFactory("Batcher");
    batcher = await Batcher.deploy(BATCH_SIZE, debtTokenAddress, liquidityTokenAddress, lpAddress);

    // Approve batcher to spend alice's debt token
    const approvalAmount = fhevm.createEncryptedInput(debtTokenAddress, alice.address);
    approvalAmount.add64(100);
    const approvalAmountEncrypted = await approvalAmount.encrypt();

    // Approve and deposit
    await debtToken
      .connect(alice)
      ["approve(address,bytes32,bytes)"](
        batcher,
        approvalAmountEncrypted.handles[0],
        approvalAmountEncrypted.inputProof,
      );

    // Approve batcher to spend bob's debt token
    const approvalAmountB = fhevm.createEncryptedInput(debtTokenAddress, bob.address);
    approvalAmountB.add64(100);
    const approvalAmountEncryptedB = await approvalAmountB.encrypt();

    // Approve and deposit
    await debtToken
      .connect(bob)
      ["approve(address,bytes32,bytes)"](
        batcher,
        approvalAmountEncryptedB.handles[0],
        approvalAmountEncryptedB.inputProof,
      );
  });

  it("should allow single deposit", async function () {
    const depositAmount = fhevm.createEncryptedInput(await batcher.getAddress(), alice.address);
    depositAmount.add64(100);
    const depositAmountEncrypted = await depositAmount.encrypt();
    await batcher
      .connect(alice)
      ["deposit(bytes32,bytes)"](depositAmountEncrypted.handles[0], depositAmountEncrypted.inputProof);

    // Check balances
    const aliceBalance = await debtToken.balanceOf(alice.address);
    const decryptedBalance = await debug.decrypt64(aliceBalance);
    expect(decryptedBalance).to.equal(900n);

    const batcherBalance = await debtToken.balanceOf(batcher);
    const decryptedBatcherBalance = await debug.decrypt64(batcherBalance);
    expect(decryptedBatcherBalance).to.equal(100n);
  });

  it("should process batch when reaching batch size", async function () {
    // First deposit
    const depositAmountAlice = await fhevm
      .createEncryptedInput(await batcher.getAddress(), alice.address)
      .add64(100)
      .encrypt();
    await batcher
      .connect(alice)
      ["deposit(bytes32,bytes)"](depositAmountAlice.handles[0], depositAmountAlice.inputProof);

    // Second deposit
    const depositAmountBob = await fhevm
      .createEncryptedInput(await batcher.getAddress(), bob.address)
      .add64(100)
      .encrypt();
    const tx = await batcher
      .connect(bob)
      ["deposit(bytes32,bytes)"](depositAmountBob.handles[0], depositAmountBob.inputProof);
    await tx.wait();
    // Check liquidity token balances
    const aliceLPBalance = await liquidityToken.balanceOf(alice.address);
    const decryptedAliceLPBalance = await debug.decrypt64(aliceLPBalance);
    expect(decryptedAliceLPBalance).to.equal(100n);
  });
});
