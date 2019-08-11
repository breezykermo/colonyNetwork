/* global artifacts */
import chai from "chai";
import bnChai from "bn-chai";

import { WAD, SECONDS_PER_DAY } from "../../helpers/constants";
import { checkErrorRevert, getTokenArgs, forwardTime } from "../../helpers/test-helper";
import { fundColonyWithTokens, setupRandomColony } from "../../helpers/test-data-generator";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const EtherRouter = artifacts.require("EtherRouter");
const IColonyNetwork = artifacts.require("IColonyNetwork");
const IReputationMiningCycle = artifacts.require("IReputationMiningCycle");
const IMetaColony = artifacts.require("IMetaColony");
const Token = artifacts.require("Token");

contract("Colony Expenditure", accounts => {
  const RECIPIENT = accounts[3];
  const ADMIN = accounts[4];
  const USER = accounts[10];

  const ACTIVE = 0;
  const CANCELLED = 1;
  const FINALIZED = 2;

  let colony;
  let token;
  let otherToken;
  let colonyNetwork;
  let metaColony;

  before(async () => {
    const etherRouter = await EtherRouter.deployed();
    colonyNetwork = await IColonyNetwork.at(etherRouter.address);
    const metaColonyAddress = await colonyNetwork.getMetaColony();
    metaColony = await IMetaColony.at(metaColonyAddress);

    ({ colony, token } = await setupRandomColony(colonyNetwork));
    await colony.setRewardInverse(100);
    await colony.setAdministrationRole(1, 0, ADMIN, 1, true);
    await fundColonyWithTokens(colony, token, WAD.muln(20));

    const tokenArgs = getTokenArgs();
    otherToken = await Token.new(...tokenArgs);
    await otherToken.unlock();
    await fundColonyWithTokens(colony, otherToken, WAD.muln(20));
  });

  describe("when adding expenditures", () => {
    it("should allow admins to add expenditure", async () => {
      const expendituresCountBefore = await colony.getExpenditureCount();
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });

      const expendituresCountAfter = await colony.getExpenditureCount();
      expect(expendituresCountAfter.sub(expendituresCountBefore)).to.eq.BN(1);

      const fundingPotId = await colony.getFundingPotCount();
      const expenditure = await colony.getExpenditure(expendituresCountAfter);

      expect(expenditure.fundingPotId).to.eq.BN(fundingPotId);
      expect(expenditure.domainId).to.eq.BN(1);

      const fundingPot = await colony.getFundingPot(fundingPotId);
      expect(fundingPot.associatedType).to.eq.BN(4); // 4 = FundingPotAssociatedType.Expenditure
      expect(fundingPot.associatedTypeId).to.eq.BN(expendituresCountAfter);
    });

    it("should not allow non-admins to add expenditure", async () => {
      await checkErrorRevert(colony.makeExpenditure(1, 0, 1, { from: USER }), "ds-auth-unauthorized");
    });

    it("should allow owners to cancel expenditures", async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      const expenditureId = await colony.getExpenditureCount();

      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(ACTIVE);

      await checkErrorRevert(colony.cancelExpenditure(expenditureId, { from: USER }), "colony-expenditure-not-owner");
      await colony.cancelExpenditure(expenditureId, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(CANCELLED);
      expect(expenditure.finalizedTimestamp).to.be.zero;
    });

    it("should allow owners to transfer expenditures", async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      const expenditureId = await colony.getExpenditureCount();

      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.owner).to.equal(ADMIN);

      await checkErrorRevert(colony.transferExpenditure(expenditureId, USER), "colony-expenditure-not-owner");
      await colony.transferExpenditure(expenditureId, USER, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.owner).to.equal(USER);
    });
  });

  describe("when updating expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should error if the expenditure does not exist", async () => {
      await checkErrorRevert(colony.setExpenditureSkill(100, RECIPIENT, 3, { from: ADMIN }), "colony-expenditure-does-not-exist");
    });

    it("should allow owners to update a recipient skill", async () => {
      let recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.skills.length).to.be.zero;

      await colony.setExpenditureSkill(expenditureId, RECIPIENT, 3, { from: ADMIN });
      recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.skills[0]).to.eq.BN(3);
    });

    it("should not allow owners to set a non-global skill or a deprecated global skill", async () => {
      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, 2, { from: ADMIN }), "colony-not-global-skill");

      await metaColony.addGlobalSkill();
      const skillId = await colonyNetwork.getSkillCount();
      await metaColony.deprecateGlobalSkill(skillId);

      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, skillId, { from: ADMIN }), "colony-deprecated-global-skill");
    });

    it("should not allow non-owners to update skills or payouts", async () => {
      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, 3), "colony-expenditure-not-owner");
      await checkErrorRevert(colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD), "colony-expenditure-not-owner");
    });

    it("should allow owners to add a recipient payout", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.payoutScalar).to.eq.BN(WAD);

      const payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.eq.BN(WAD);
    });

    it("should be able to add multiple payouts in different tokens", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, 100, { from: ADMIN });
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, otherToken.address, 200, { from: ADMIN });

      const payoutForToken = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      const payoutForOtherToken = await colony.getExpenditurePayout(expenditureId, RECIPIENT, otherToken.address);
      expect(payoutForToken).to.eq.BN(100);
      expect(payoutForOtherToken).to.eq.BN(200);
    });

    it("should allow owner to set token payout to zero", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      let payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.eq.BN(WAD);

      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, 0, { from: ADMIN });

      payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.be.zero;
    });

    it("should correctly account for multiple payouts in the same token", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayout(expenditureId, ADMIN, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      let totalPayout = await colony.getFundingPotPayout(expenditure.fundingPotId, token.address);
      expect(totalPayout).to.eq.BN(WAD.muln(2));

      await colony.setExpenditurePayout(expenditureId, ADMIN, token.address, 0, { from: ADMIN });

      totalPayout = await colony.getFundingPotPayout(expenditure.fundingPotId, token.address);
      expect(totalPayout).to.eq.BN(WAD);
    });

    it("should allow arbitration users to set the payoutScalar", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      await checkErrorRevert(colony.setExpenditurePayoutScalar(1, 0, expenditureId, RECIPIENT, WAD.divn(2), { from: ADMIN }), "ds-auth-unauthorized");

      await colony.setExpenditurePayoutScalar(1, 0, expenditureId, RECIPIENT, WAD.divn(2));

      const recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.payoutScalar).to.eq.BN(WAD.divn(2));
    });

    it("should allow arbitration users to set the claimDelay", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      await checkErrorRevert(
        colony.setExpenditureClaimDelay(1, 0, expenditureId, RECIPIENT, SECONDS_PER_DAY, { from: ADMIN }),
        "ds-auth-unauthorized"
      );

      await colony.setExpenditureClaimDelay(1, 0, expenditureId, RECIPIENT, SECONDS_PER_DAY);

      const recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.claimDelay).to.eq.BN(SECONDS_PER_DAY);
    });
  });

  describe("when finalizing expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should allow owners to finalize expenditures", async () => {
      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(ACTIVE);

      await checkErrorRevert(colony.finalizeExpenditure(expenditureId, { from: USER }), "colony-expenditure-not-owner");
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(FINALIZED);
      expect(expenditure.finalizedTimestamp).to.not.be.zero;
    });

    it("cannot finalize expenditure if it is not fully funded", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      await checkErrorRevert(colony.finalizeExpenditure(expenditureId, { from: ADMIN }), "colony-expenditure-not-funded");

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);

      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
    });

    it("should not allow admins to update payouts", async () => {
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await checkErrorRevert(
        colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN }),
        "colony-expenditure-not-active"
      );
    });

    it("should not allow admins to update skills", async () => {
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, 1, { from: ADMIN }), "colony-expenditure-not-active");
    });
  });

  describe("when claiming expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should allow anyone to claim on behalf of the recipient, with network fee deducted", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      const recipientBalanceBefore = await token.balanceOf(RECIPIENT);
      const networkBalanceBefore = await token.balanceOf(colonyNetwork.address);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);

      const recipientBalanceAfter = await token.balanceOf(RECIPIENT);
      const networkBalanceAfter = await token.balanceOf(colonyNetwork.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq.BN(WAD.divn(100).muln(99).subn(1)); // eslint-disable-line prettier/prettier
      expect(networkBalanceAfter.sub(networkBalanceBefore)).to.eq.BN(WAD.divn(100).addn(1)); // eslint-disable-line prettier/prettier
    });

    it("should allow anyone to claim on behalf of the recipient, in multiple tokens", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, otherToken.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, otherToken.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      const tokenBalanceBefore = await token.balanceOf(RECIPIENT);
      const otherTokenBalanceBefore = await otherToken.balanceOf(RECIPIENT);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, otherToken.address);

      const tokenBalanceAfter = await token.balanceOf(RECIPIENT);
      const otherTokenBalanceAfter = await otherToken.balanceOf(RECIPIENT);
      expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.eq.BN(WAD.divn(100).muln(99).subn(1)); // eslint-disable-line prettier/prettier
      expect(otherTokenBalanceAfter.sub(otherTokenBalanceBefore)).to.eq.BN(WAD.divn(100).muln(99).subn(1)); // eslint-disable-line prettier/prettier
    });

    it("after expenditure is claimed it should set the payout to 0", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);

      const payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.be.zero;
    });

    it("if skill is set, should emit two reputation updates", async () => {
      const skillId = 3;
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditureSkill(expenditureId, RECIPIENT, skillId, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);

      const addr = await colonyNetwork.getReputationMiningCycle(false);
      const repCycle = await IReputationMiningCycle.at(addr);
      const numEntries = await repCycle.getReputationUpdateLogLength();

      const skillEntry = await repCycle.getReputationUpdateLogEntry(numEntries.subn(1));
      expect(skillEntry.user).to.equal(RECIPIENT);
      expect(skillEntry.skillId).to.eq.BN(skillId);
      expect(skillEntry.amount).to.eq.BN(WAD);

      const domainEntry = await repCycle.getReputationUpdateLogEntry(numEntries.subn(2));
      expect(domainEntry.user).to.equal(RECIPIENT);
      expect(domainEntry.amount).to.eq.BN(WAD);
    });

    it("should scale down payout by payoutScalar", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayoutScalar(1, 0, expenditureId, RECIPIENT, WAD.divn(2));

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      const recipientBalanceBefore = await token.balanceOf(RECIPIENT);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);

      // Cash payout scaled down
      const recipientBalanceAfter = await token.balanceOf(RECIPIENT);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq.BN(WAD.divn(2).divn(100).muln(99).subn(1)); // eslint-disable-line prettier/prettier

      // Reputation is scaled down the same amount
      const addr = await colonyNetwork.getReputationMiningCycle(false);
      const repCycle = await IReputationMiningCycle.at(addr);
      const numEntries = await repCycle.getReputationUpdateLogLength();
      const entry = await repCycle.getReputationUpdateLogEntry(numEntries.subn(1));
      expect(entry.user).to.equal(RECIPIENT);
      expect(entry.amount).to.eq.BN(WAD.divn(2));
    });

    it("should scale up payout by payoutScalar", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayoutScalar(1, 0, expenditureId, RECIPIENT, WAD.muln(2));

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      const recipientBalanceBefore = await token.balanceOf(RECIPIENT);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);

      // Cash payout maxes out at payout
      const recipientBalanceAfter = await token.balanceOf(RECIPIENT);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq.BN(WAD.divn(100).muln(99).subn(1)); // eslint-disable-line prettier/prettier

      // But reputation gets a boost
      const addr = await colonyNetwork.getReputationMiningCycle(false);
      const repCycle = await IReputationMiningCycle.at(addr);
      const numEntries = await repCycle.getReputationUpdateLogLength();
      const entry = await repCycle.getReputationUpdateLogEntry(numEntries.subn(1));
      expect(entry.user).to.equal(RECIPIENT);
      expect(entry.amount).to.eq.BN(WAD.muln(2));
    });

    it("should delay claims by claimDelay", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditureClaimDelay(1, 0, expenditureId, RECIPIENT, SECONDS_PER_DAY);

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      await checkErrorRevert(colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address), "colony-expenditure-cannot-claim");

      await forwardTime(SECONDS_PER_DAY, this);
      await colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address);
    });

    it("should error when expenditure is not finalized", async () => {
      await checkErrorRevert(colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address), "colony-expenditure-not-finalized");
    });
  });

  describe("when cancelling expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should not be claimable", async () => {
      await colony.cancelExpenditure(expenditureId, { from: ADMIN });
      await checkErrorRevert(colony.claimExpenditurePayout(expenditureId, RECIPIENT, token.address), "colony-expenditure-cancelled");
    });

    it("should let funds be reclaimed", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);

      // Try to move funds back
      await checkErrorRevert(
        colony.moveFundsBetweenPots(1, 0, 0, expenditure.fundingPotId, 1, WAD, token.address),
        "colony-funding-expenditure-bad-state"
      );

      await colony.cancelExpenditure(expenditureId, { from: ADMIN });
      await colony.moveFundsBetweenPots(1, 0, 0, expenditure.fundingPotId, 1, WAD, token.address);
    });
  });
});
