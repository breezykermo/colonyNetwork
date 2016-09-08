/* eslint-env node, mocha */
// These globals are added by Truffle:
/* globals contract, RootColony, Colony, EternalStorage, assert, web3 */

import { solSha3 } from 'colony-utils';
import testHelper from '../helpers/test-helper';

contract('TokenLibrary, VotingLibrary and Colony', function (accounts) {
  let _COLONY_KEY_;
  const _MAIN_ACCOUNT_ = accounts[0];
  const _OTHER_ACCOUNT_ = accounts[1];
  let rootColony;
  let colony;
  let eternalStorage;
  let eternalStorageRoot;

  const _POLL_ID_1_ = 1;
  const _POLL_ID_2_ = 2;
  let _VOTE_SECRET_1_;
  let _VOTE_SALT_1_;

  const queueCreateAndOpenSimplePoll = async function(description, pollCount, duration) {
    let tx;
    const gasEstimate = await colony.createPoll.estimateGas(description);
    tx = await colony.createPoll.sendTransaction(description, { gas: Math.floor(gasEstimate * 1.1) });
    console.log('createPoll tx id ', tx);
    tx = await colony.addPollOption.sendTransaction(pollCount, 'Yes', { gas: 150000 });
    console.log('addPollOption tx id ', tx);
    tx = await colony.addPollOption.sendTransaction(pollCount, 'No', { gas: 150000 });
    console.log('addPollOption tx id ', tx);
    tx = await colony.openPoll.sendTransaction(pollCount, duration, { gas: 300000 });
    console.log('openPoll tx id ', tx);
    return tx;
  };

  const createAndOpenSimplePoll = async function(description, duration) {
    await colony.createPoll(description);
    const pollCount = await eternalStorage.getUIntValue.call(solSha3('PollCount'));
    await colony.addPollOption(pollCount.toNumber(), 'Yes');
    await colony.addPollOption(pollCount.toNumber(), 'No');
    await colony.openPoll(pollCount.toNumber(), duration);
  };

  const earnTokens = async function(account, amountToEarn) {
    // Earn some tokens
    const amount = amountToEarn / 0.95;
    await colony.generateTokensWei(amount);
    await colony.makeTask('name2', 'summary2');
    await colony.contributeTokensWeiFromPool(0, amount);
    await colony.completeAndPayTask(0, account);
  };

  before(async function (done) {
    rootColony = RootColony.deployed();
    eternalStorageRoot = EternalStorage.deployed();
    done();
  });

  beforeEach(function (done) {
    _VOTE_SALT_1_ = solSha3('SALT1');
    _VOTE_SECRET_1_ = solSha3(_VOTE_SALT_1_, 1); // i.e. we're always voting for option1

    _COLONY_KEY_ = testHelper.getRandomString(7);

    eternalStorageRoot.owner.call()
      .then(function () {
        rootColony.createColony(_COLONY_KEY_, { from: _MAIN_ACCOUNT_ });
        testHelper.mineTransaction();
      })
      .then(function () {
        return rootColony.getColony.call(_COLONY_KEY_);
      })
      .then(function (colony_) {
        colony = Colony.at(colony_);
        return;
      })
      .then(function () {
        return colony.eternalStorage.call();
      })
      .then(function (extStorageAddress) {
        eternalStorage = EternalStorage.at(extStorageAddress);
        return;
      })
      .then(done)
      .catch(done);
  });

  describe('when resolving a poll', function () {
    it('should update the poll status correctly', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 1);
        testHelper.forwardTime((3600 * 2) + 1000);
        await colony.resolvePoll(1);
        const pollStatus = await eternalStorage.getUIntValue.call(solSha3('Poll', 1, 'status'));
        assert.equal(2, pollStatus.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('before the minimum needed time to have passed, it should fail', async function(done) {
      await createAndOpenSimplePoll('poll 1', 1);
      await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
      testHelper.forwardTime(3600 + 1000); // fast forward in time to get past the poll close time of 1 hour
      // Try to resolve the poll early
      await colony.resolvePoll(1);
      const pollStatus = await eternalStorage.getUIntValue.call(solSha3('Poll', 1, 'status'));
      assert.equal(1, pollStatus.toNumber());
      done();
    });

    it('which has already been resolved, it should fail', async function(done) {
      await createAndOpenSimplePoll('poll 1', 1);
      testHelper.forwardTime((3600 * 2) + 1000);
      await colony.resolvePoll(1);
      const pollStatus = await eternalStorage.getUIntValue.call(solSha3('Poll', 1, 'status'));
      assert.equal(2, pollStatus.toNumber());
      // Try to resolve the poll again
      await colony.resolvePoll(1).catch(testHelper.ifUsingTestRPC);
      done();
    });
  });

  describe('when revealing a vote', function () {
    it('when it is the last one in the list, should remove it correctly', async function (done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        testHelper.forwardTime((24 * 3600) + 100);

        // All poll close times should be the same
        let pollCloseTime = await eternalStorage.getUIntValue.call(solSha3('Poll', _POLL_ID_1_, 'closeTime'));
        pollCloseTime = pollCloseTime.toNumber();

        await colony.revealVote(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });

        const prevPollIdNextPollId = await eternalStorage.getUIntValue(solSha3('Voting', _OTHER_ACCOUNT_, pollCloseTime, 'secrets', 0, 'nextPollId'));
        assert.equal(0, prevPollIdNextPollId);
        const prevPollIdPrevPollId = await eternalStorage.getUIntValue(solSha3('Voting', _OTHER_ACCOUNT_, pollCloseTime, 'secrets', 0, 'prevPollId'));
        assert.equal(0, prevPollIdPrevPollId);

        const poll1PrevPollIdCloseTime =
        await eternalStorage.getUIntValue(solSha3('Voting', _OTHER_ACCOUNT_, pollCloseTime, 'secrets', _POLL_ID_1_, 'prevPollId'));
        const poll1NextPollIdCloseTime =
        await eternalStorage.getUIntValue(solSha3('Voting', _OTHER_ACCOUNT_, pollCloseTime, 'secrets', _POLL_ID_1_, 'nextPollId'));
        assert.equal(0, poll1PrevPollIdCloseTime);
        assert.equal(0, poll1NextPollIdCloseTime);

        const secret = await eternalStorage.getBytes32Value(solSha3('Voting', _OTHER_ACCOUNT_, pollCloseTime, 'secrets', _POLL_ID_1_, 'secret'));
        assert.equal('0x0000000000000000000000000000000000000000000000000000000000000000', secret);
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('before the poll has closed, should fail', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        testHelper.mineTransaction();
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        const result = await colony.revealVote.call(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });
        assert.isFalse(result);
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('and the poll is resolved, should not count the vote towards final results', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        testHelper.mineTransaction();
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        testHelper.forwardTime((24 * 3600 * 2) + 100);
        await colony.resolvePoll(1);
        await colony.revealVote(1, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });

        const poll1Option1Count = await eternalStorage.getUIntValue(solSha3('Poll', _POLL_ID_1_, 'option', 1, 'count'));
        assert.equal(0, poll1Option1Count);

        done();
      } catch (err) {
        return done(err);
      }
    });

    it.skip('with invalid secret, should fail', async function(done) {
      try {
        // todo
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('should update the total count for that vote option', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        testHelper.mineTransaction();
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Earn some tokens!
        await earnTokens(_OTHER_ACCOUNT_, 95);

        testHelper.forwardTime((24 * 3600 * 2) + 100);
        await colony.revealVote(1, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });

        const poll1Option1Count = await eternalStorage.getUIntValue(solSha3('Poll', _POLL_ID_1_, 'option', 1, 'count'));
        console.log(solSha3('Poll', _POLL_ID_1_, 'option', 1, 'count'));
        assert.equal(95, poll1Option1Count.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });
  });

  describe('after having voted in a poll, when sending tokens', function () {
    it('while the poll is still open, should succeed', async function(done) {
      try {
        await colony.createPoll('My poll');
        await colony.addPollOption(1, 'Yes');
        await colony.addPollOption(1, 'No');
        await colony.openPoll(1, 1);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Earn some tokens!
        await earnTokens(_OTHER_ACCOUNT_, 95);

        // Spend some tokens
        await colony.transfer(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });

        const balanceSender = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(45, balanceSender.toNumber());
        const balanceRecipient = await colony.balanceOf.call(_MAIN_ACCOUNT_);
        assert.equal(50, balanceRecipient);

        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes, should fail', async function(done) {
      try {
        await colony.createPoll('My poll');
        await colony.addPollOption(1, 'Yes');
        await colony.addPollOption(1, 'No');
        await colony.openPoll(1, 1);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Earn some tokens!
        await earnTokens(_OTHER_ACCOUNT_, 95);

        testHelper.forwardTime(3600 + 10);
        // Transfer should fail as the account is locked
        const result = await colony.transfer.call(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });
        assert.isFalse(result);
        await colony.transfer(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });

        const balanceSender = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balanceSender.toNumber());
        const balanceRecipient = await colony.balanceOf.call(_MAIN_ACCOUNT_);
        assert.equal(0, balanceRecipient);
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and the vote is revealed but another unrevealed vote remains, should fail', async function(done) {
      try {
        await colony.createPoll('My poll 1');
        await colony.createPoll('My poll 2');
        await colony.addPollOption(1, 'Yes');
        await colony.addPollOption(1, 'No');
        await colony.addPollOption(2, 'Yes');
        await colony.addPollOption(2, 'No');
        await colony.openPoll(1, 1);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        await colony.openPoll(2, 3);
        await colony.submitVote(_POLL_ID_2_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Earn some tokens!
        await earnTokens(_OTHER_ACCOUNT_, 95);

        testHelper.forwardTime((3 * 3600) + 10);

        await colony.revealVote(1, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });

        const result = await colony.transfer.call(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });
        assert.isFalse(result);
        // Transfer should fail as the account is still locked since one more unrevealed vote remains
        await colony.transfer(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });

        const balanceSender = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balanceSender.toNumber());
        const balanceRecipient = await colony.balanceOf.call(_MAIN_ACCOUNT_);
        assert.equal(10, balanceRecipient);
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and the vote is revealed, should succeed', async function(done) {
      try {
        await colony.createPoll('My poll');
        await colony.addPollOption(1, 'Yes');
        await colony.addPollOption(1, 'No');
        await colony.openPoll(1, 1);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Earn some tokens!
        await colony.generateTokensWei(100);
        await colony.makeTask('name2', 'summary2');
        await colony.contributeTokensWeiFromPool(0, 100);
        await colony.completeAndPayTask(0, _OTHER_ACCOUNT_);

        testHelper.forwardTime(3600 + 10);

        await colony.revealVote(1, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });

        // Transfer should succeed as the account is unlocked when vote is revealed
        await colony.transfer(_MAIN_ACCOUNT_, 50, { from: _OTHER_ACCOUNT_ });

        const balanceSender = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(45, balanceSender.toNumber());
        const balanceRecipient = await colony.balanceOf.call(_MAIN_ACCOUNT_);
        assert.equal(50, balanceRecipient);
        done();
      } catch (err) {
        return done(err);
      }
    });
  });

  describe.only('after having voted in a poll, when receiving tokens', function () {
    it('while the poll is still open, should succeed', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_MAIN_ACCOUNT_, 95);
        // Transfer tokens
        await colony.transfer(_OTHER_ACCOUNT_, 95);

        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balance.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes before the vote is revealed, tokens should be in my held balance', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Poll closes
        testHelper.forwardTime((24 * 3600) + 10);
        // Earn some tokens
        await earnTokens(_MAIN_ACCOUNT_, 95);
        // Transfer tokens to a locked recipient
        await colony.transfer(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(0, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(95, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and my vote is revealed, but another unrevealed vote remains, should keep my tokens on hold', async function(done) {
      try {
        // Start two polls at the same pollCloseTime
        await testHelper.stopMining();
        let pollCount = await eternalStorage.getUIntValue.call(solSha3('PollCount'));
        pollCount = pollCount.toNumber();
        await queueCreateAndOpenSimplePoll('poll 1', pollCount + 1, 24);
        await queueCreateAndOpenSimplePoll('poll 2', pollCount + 2, 24);
        testHelper.startMining();
        // Start another poll at a different poll close time
        testHelper.forwardTime(200);
        await createAndOpenSimplePoll('poll 3', 24);
        // Vote in both polls
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        await colony.submitVote(_POLL_ID_2_, _VOTE_SECRET_1_, 0, _POLL_ID_1_, { from: _OTHER_ACCOUNT_ });
        // All 3 polls close
        testHelper.forwardTime(25 * 3600);
        // Reveal one vote
        await colony.revealVote(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_MAIN_ACCOUNT_, 95);
        // Transfer tokens to a locked recipient
        await colony.transfer(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(0, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(95, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and after my vote is revealed, should be in my normal balance', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 3', 24);
        // Vote in both polls
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        // All 3 polls close
        testHelper.forwardTime(25 * 3600);
        // Reveal one vote
        await colony.revealVote(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_MAIN_ACCOUNT_, 95);
        // Transfer tokens
        await colony.transfer(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(0, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });
  });

  describe('after having voted in a poll, when getting tokens for completing a task', function () {
    it('while the poll is still open, should succeed', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_OTHER_ACCOUNT_, 95);

        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balance.toNumber());

        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes before the vote is revealed, tokens should be in my held balance', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 1', 24);
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });

        // Poll closes
        testHelper.forwardTime((24 * 3600) + 10);
        // Earn some tokens
        await earnTokens(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(0, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(95, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and my vote is revealed, but another unrevealed vote remains, should keep my tokens on hold', async function(done) {
      try {
        // Start two polls at the same pollCloseTime
        await testHelper.stopMining();
        let pollCount = await eternalStorage.getUIntValue.call(solSha3('PollCount'));
        pollCount = pollCount.toNumber();
        await queueCreateAndOpenSimplePoll('poll 1', pollCount + 1, 24);
        await queueCreateAndOpenSimplePoll('poll 2', pollCount + 2, 24);
        testHelper.startMining();
        // Start another poll at a different poll close time
        testHelper.forwardTime(200);
        await createAndOpenSimplePoll('poll 3', 24);
        // Vote in both polls
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        await colony.submitVote(_POLL_ID_2_, _VOTE_SECRET_1_, 0, _POLL_ID_1_, { from: _OTHER_ACCOUNT_ });
        // All 3 polls close
        testHelper.forwardTime(25 * 3600);
        // Reveal one vote
        await colony.revealVote(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(0, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(95, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });

    it('after the poll closes and after my vote is revealed, should be in my normal balance', async function(done) {
      try {
        await createAndOpenSimplePoll('poll 3', 24);
        // Vote in both polls
        await colony.submitVote(_POLL_ID_1_, _VOTE_SECRET_1_, 0, 0, { from: _OTHER_ACCOUNT_ });
        // All 3 polls close
        testHelper.forwardTime(25 * 3600);
        // Reveal one vote
        await colony.revealVote(_POLL_ID_1_, 1, _VOTE_SALT_1_, { from: _OTHER_ACCOUNT_ });
        // Earn some tokens
        await earnTokens(_OTHER_ACCOUNT_, 95);
        // Token balance is 0
        const balance = await colony.balanceOf.call(_OTHER_ACCOUNT_);
        assert.equal(95, balance.toNumber());
        // Held balance
        const heldTokens = await eternalStorage.getUIntValue.call(solSha3('onhold:', _OTHER_ACCOUNT_));
        assert.equal(0, heldTokens.toNumber());
        done();
      } catch (err) {
        return done(err);
      }
    });
  });
});