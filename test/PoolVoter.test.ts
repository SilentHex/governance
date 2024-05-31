import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ACLManager,
  AaveOracle,
  AaveProtocolDataProvider,
  LendingPoolGaugeFactory,
  OmnichainStaking,
  Pool,
  PoolAddressesProvider,
  PoolConfigurator,
  PoolVoter,
  StakingBonus,
  TestnetERC20,
  VestedZeroNFT,
  ZeroLend,
} from "../typechain-types";
import { e18 } from "./fixtures/utils";
import { deployVoters } from "./fixtures/voters";
import { ethers } from "hardhat";
import { deployLendingPool } from "./fixtures/lending";
import {
  BaseContract,
  ContractTransactionResponse,
  parseEther,
  parseUnits,
} from "ethers";

describe.skip("PoolVoter", () => {
  let ant: SignerWithAddress;
  let now: number;
  let omniStaking: OmnichainStaking;
  let poolVoter: PoolVoter;
  let reserve: TestnetERC20;
  let stakingBonus: StakingBonus;
  let vest: VestedZeroNFT;
  let pool: Pool;
  let zero: ZeroLend;
  let lending: {
    erc20: any;
    owner?: SignerWithAddress;
    configurator?: PoolConfigurator;
    pool?: Pool;
    oracle?: AaveOracle & {
      deploymentTransaction(): ContractTransactionResponse;
    };
    addressesProvider?: PoolAddressesProvider & {
      deploymentTransaction(): ContractTransactionResponse;
    };
    aclManager?: ACLManager & {
      deploymentTransaction(): ContractTransactionResponse;
    };
    protocolDataProvider?: AaveProtocolDataProvider & {
      deploymentTransaction(): ContractTransactionResponse;
    };
    mockAggregator?: BaseContract & {
      deploymentTransaction(): ContractTransactionResponse;
    } & Omit<BaseContract, keyof BaseContract>;
  };
  let lendingPoolGaugeFactory: LendingPoolGaugeFactory & {
    deploymentTransaction(): ContractTransactionResponse;
  };
  beforeEach(async () => {
    const deployment = await loadFixture(deployVoters);
    ant = deployment.ant;
    now = Math.floor(Date.now() / 1000);
    omniStaking = deployment.governance.omnichainStaking;
    poolVoter = deployment.poolVoter;
    reserve = deployment.lending.erc20;
    stakingBonus = deployment.governance.stakingBonus;
    vest = deployment.governance.vestedZeroNFT;
    zero = deployment.governance.zero;
    pool = deployment.lending.pool;
    lending = deployment.lending;
    lendingPoolGaugeFactory = deployment.factory;

    // deployer should be able to mint a nft for another user
    await vest.mint(
      ant.address,
      e18 * 20n, // 20 ZERO linear vesting
      0, // 0 ZERO upfront
      1000, // linear duration - 1000 seconds
      0, // cliff duration - 0 seconds
      now + 1000, // unlock date
      true, // penalty -> false
      0
    );

    // stake nft on behalf of the ant
    await vest
      .connect(ant)
      ["safeTransferFrom(address,address,uint256)"](
        ant.address,
        stakingBonus.target,
        1
      );

    // there should now be some voting power for the user to play with
    expect(await omniStaking.balanceOf(ant.address)).greaterThan(e18 * 19n);
  });

  it("should allow users to vote properly", async function () {
    expect(await poolVoter.totalWeight()).eq(0);
    await poolVoter.connect(ant).vote([reserve.target], [1e8]);
    expect(await poolVoter.totalWeight()).greaterThan(e18 * 19n);
  });

  describe("handleAction test", () => {
    it("supplying an asset with ZERO staked should give staking rewards", async function () {
      expect(await aTokenGauge.balanceOf(ant.address)).eq(0n);
      expect(await aTokenGauge.totalSupply()).eq(0);

      await reserve["mint(address,uint256)"](ant.address, e18 * 1000n);
      await reserve.connect(ant).approve(pool.target, e18 * 100n);
      await pool
        .connect(ant)
        .supply(reserve.target, e18 * 100n, ant.address, 0);

      expect(await aTokenGauge.balanceOf(ant.address)).eq(e18 * 100n);
      expect(await aTokenGauge.totalSupply()).eq(e18 * 100n);
    });
  });

  describe("distribute tests", () => {
    let gauges: [string, string, string] & {
      splitterGauge: string;
      aTokenGauge: string;
      varTokenGauge: string;
    };
    beforeEach(async () => {
      await reserve["mint(address,uint256)"](ant.address, e18 * 1000n);
      await reserve.connect(ant).approve(pool.target, e18 * 100n);
      await pool
        .connect(ant)
        .supply(reserve.target, e18 * 100n, ant.address, 0);

      await poolVoter.connect(ant).vote([reserve.target], [parseEther("1")]);
      await zero.approve(poolVoter.target, parseEther("1"));
      await poolVoter.notifyRewardAmount(parseEther("1"));

      gauges = await lendingPoolGaugeFactory.gauges(reserve.target);

      await poolVoter.updateFor(gauges.splitterGauge);
    });

    it("should distribute rewards to gauges", async function () {
      await poolVoter["distribute()"]();
      expect(await zero.balanceOf(gauges.aTokenGauge)).to.closeTo(
        parseEther("0.25"),
        100
      );
      expect(await zero.balanceOf(gauges.varTokenGauge)).to.closeTo(
        parseEther("0.75"),
        100
      );
    });

    it("should distribute rewards to a specified gauge", async function () {
      await poolVoter["distribute(address)"](gauges.splitterGauge);
      expect(await zero.balanceOf(gauges.aTokenGauge)).to.closeTo(
        parseEther("0.25"),
        100
      );
      expect(await zero.balanceOf(gauges.varTokenGauge)).to.closeTo(
        parseEther("0.75"),
        100
      );
    });

    it("should distribute rewards to specified gauges", async function () {
      await poolVoter["distribute(address[])"]([gauges.splitterGauge]);
      expect(await zero.balanceOf(gauges.aTokenGauge)).to.closeTo(
        parseEther("0.25"),
        100
      );
      expect(await zero.balanceOf(gauges.varTokenGauge)).to.closeTo(
        parseEther("0.75"),
        100
      );
    });
  });

  describe("distributeEx tests", () => {
    let gauges: [string, string, string] & {
      splitterGauge: string;
      aTokenGauge: string;
      varTokenGauge: string;
    };
    beforeEach(async () => {
      await poolVoter.connect(ant).vote([reserve.target], [parseEther("1")]);
      await zero.approve(poolVoter.target, parseEther("1"));
      await poolVoter.notifyRewardAmount(parseEther("1"));

      gauges = await lendingPoolGaugeFactory.gauges(reserve.target);
    });
    it("should distribute rewards to gauges for a specified token", async function () {
      await poolVoter["distributeEx(address)"](zero.target);
      expect(await zero.balanceOf(gauges.aTokenGauge)).to.eq(
        parseEther("0.25")
      );
      expect(await zero.balanceOf(gauges.varTokenGauge)).to.eq(
        parseEther("0.75")
      );
    });

    it("should distribute rewards to gauges for a specified token", async function () {
      await poolVoter["distributeEx(address,uint256,uint256)"](
        zero.target,
        0,
        1
      );
      expect(await zero.balanceOf(gauges.aTokenGauge)).to.eq(
        parseEther("0.25")
      );
      expect(await zero.balanceOf(gauges.varTokenGauge)).to.eq(
        parseEther("0.75")
      );
    });
  });

  it("should allow owner to reset contract", async function () {
    await poolVoter.connect(ant).vote([reserve.target], [1e8]);
    await poolVoter.connect(ant).reset();
    expect(await poolVoter.totalWeight()).to.eq(0);
  });

  it("should allow owner to register gauge", async function () {
    const newLendingPool = await deployLendingPool();

    //Using this random address for a guage
    const someRandomAddress = "0x388C818CA8B9251b393131C08a736A67ccB19297";

    await poolVoter.registerGauge(
      newLendingPool.erc20.target,
      someRandomAddress
    );

    const pools = await poolVoter.pools();
    expect(await poolVoter.gauges(pools[1])).to.equal(someRandomAddress);
  });

  it("should update for a gauge", async function () {
    const pools = await poolVoter.pools();
    await poolVoter.updateFor(await poolVoter.gauges(pools[0]));

    const gauges = await lendingPoolGaugeFactory.gauges(reserve.target);
    expect(await poolVoter.supplyIndex(gauges.splitterGauge)).to.equal(
      await poolVoter.index()
    );
  });

  it("should return the correct length after registering pools", async function () {
    expect(await poolVoter.length()).to.equal(1);
    const pool2 = ethers.getAddress(
      "0x0000000000000000000000000000000000000002"
    );
    const pool3 = ethers.getAddress(
      "0x0000000000000000000000000000000000000003"
    );

    await poolVoter.registerGauge(pool2, ethers.ZeroAddress);
    await poolVoter.registerGauge(pool3, ethers.ZeroAddress);

    const expectedLength = 3;
    const actualLength = await poolVoter.length();

    expect(actualLength).to.equal(expectedLength);
  });

  it("should update the voting state correctly after a user pokes", async function () {
    await poolVoter.connect(ant).vote([reserve.target], [1e8]);

    const poolWeightBeforeStaking = await poolVoter.totalWeight();
    await vest.mint(ant.address, e18 * 20n, 0, 1000, 0, now + 1000, true, 0);

    await vest
      .connect(ant)
      ["safeTransferFrom(address,address,uint256)"](
        ant.address,
        stakingBonus.target,
        2
      );

    await poolVoter.poke(ant.address);

    const poolWeightAfterStaking = await poolVoter.totalWeight();
    expect(poolWeightAfterStaking).to.be.closeTo(
      2n * poolWeightBeforeStaking,
      parseUnits("1", 12)
    );
  });
});
