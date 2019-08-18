/*
  This file is part of The Colony Network.

  The Colony Network is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  The Colony Network is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with The Colony Network. If not, see <http://www.gnu.org/licenses/>.
*/

pragma solidity 0.5.8;
pragma experimental ABIEncoderV2;

import "./../ColonyAuthority.sol";
import "./../ColonyDataTypes.sol";
import "./../IColony.sol";
import "./../IColonyNetwork.sol";


contract OneTxPayment {
  bytes4 constant MAKE_EXPENDITURE_SIG = bytes4(keccak256("makeExpenditure(uint256,uint256,uint256)"));
  bytes4 constant MOVE_FUNDS_SIG = bytes4(keccak256("moveFundsBetweenPots(uint256,uint256,uint256,uint256,uint256,uint256,address)"));

  IColony colony;
  IColonyNetwork colonyNetwork;

  constructor(address _colony) public {
    colony = IColony(_colony);
    colonyNetwork = IColonyNetwork(colony.getColonyNetwork());
  }

  /// @notice Completes a payment in a single transaction
  /// @dev Assumes that each entity holds administration and funding roles in the same domain,
  /// although contract and caller can have the permissions in different domains.
  /// Funding is taken from root domain, and the caller must have funding permission explicitly in the root domain
  /// @param _permissionDomainId The domainId in which the _contract_ has permissions to add a payment and fund it
  /// @param _childSkillIndex Index of the _permissionDomainId skill.children array to get
  /// @param _callerPermissionDomainId The domainId in which the _caller_ has permissions to add a payment and fund it
  /// @param _callerChildSkillIndex Index of the _callerPermissionDomainId skill.children array to get
  /// @param _recipient The address of the recipient of the payment
  /// @param _token The address of the token the payment is being made in. 0x00 for Ether.
  /// @param _amount The amount of the token being paid out
  /// @param _domainId The Id of the domain the payment should be coming from
  /// @param _skillId The Id of the skill that the payment should be marked with, possibly awarding reputation in this skill.
  function makePayment(
    uint256 _permissionDomainId,
    uint256 _childSkillIndex,
    uint256 _callerPermissionDomainId,
    uint256 _callerChildSkillIndex,
    address payable _recipient,
    address _token,
    uint256 _amount,
    uint256 _domainId,
    uint256 _skillId
  )
    public
  {
    validateCallerPermissions(_callerPermissionDomainId, _callerChildSkillIndex, _domainId);

    // In addition, check the caller is able to call moveFundsBetweenPots from the root domain
    require(
      ColonyAuthority(colony.authority()).canCall(msg.sender, 1, address(colony), MOVE_FUNDS_SIG),
      "colony-one-tx-payment-root-funding-not-authorized"
    );

    // Make a new expenditure
    uint256 expenditureId = colony.makeExpenditure(_permissionDomainId, _childSkillIndex, _domainId);
    colony.setExpenditurePayout(expenditureId, _recipient, _token, _amount);
    colony.setExpenditureSkill(expenditureId, _recipient, _skillId);

    // Fund the expenditure
    uint256 expenditureFundingPotId;
    ( , , expenditureFundingPotId, , ) = colony.getExpenditure(expenditureId);
    colony.moveFundsBetweenPots(
      1, // Root domain always 1
      0, // Not used, this extension contract must have funding permission in the root for this function to work
      _childSkillIndex,
      1, // Root domain funding pot is always 1
      expenditureFundingPotId,
      _amount,
      _token
    );
    colony.finalizeExpenditure(expenditureId);

    // Claim payout on behalf of the recipient
    colony.claimExpenditurePayout(expenditureId, _recipient, _token);
  }

  /// @notice Completes a payment in a single transaction
  /// @dev Assumes that each entity holds administration and funding roles in the same domain,
  /// although contract and caller can have the permissions in different domains.
  /// Funding is taken from domain funds - if the domain does not have sufficient funds, call will fail.
  /// @param _permissionDomainId The domainId in which the _contract_ has permissions to add a payment and fund it
  /// @param _childSkillIndex Index of the _permissionDomainId skill.children array to get
  /// @param _callerPermissionDomainId The domainId in which the _caller_ has permissions to add a payment and fund it
  /// @param _callerChildSkillIndex Index of the _callerPermissionDomainId skill.children array to get
  /// @param _recipient The address of the recipient of the payment
  /// @param _token The address of the token the payment is being made in. 0x00 for Ether.
  /// @param _amount The amount of the token being paid out
  /// @param _domainId The Id of the domain the payment should be coming from
  /// @param _skillId The Id of the skill that the payment should be marked with, possibly awarding reputation in this skill.
  function makePaymentFundedFromDomain(
    uint256 _permissionDomainId,
    uint256 _childSkillIndex,
    uint256 _callerPermissionDomainId,
    uint256 _callerChildSkillIndex,
    address payable _recipient,
    address _token,
    uint256 _amount,
    uint256 _domainId,
    uint256 _skillId
  )
    public
  {
    validateCallerPermissions(_callerPermissionDomainId, _callerChildSkillIndex, _domainId);

    // Make a new expenditure
    uint256 expenditureId = colony.makeExpenditure(_permissionDomainId, _childSkillIndex, _domainId);
    colony.setExpenditurePayout(expenditureId, _recipient, _token, _amount);
    colony.setExpenditureSkill(expenditureId, _recipient, _skillId);

    // Fund the expenditure
    uint256 domainFundingPotId = colony.getDomain(_domainId).fundingPotId;
    uint256 expenditureFundingPotId;
    ( , , expenditureFundingPotId, , ) = colony.getExpenditure(expenditureId);
    colony.moveFundsBetweenPots(
      _permissionDomainId,
      _childSkillIndex,
      _childSkillIndex,
      domainFundingPotId,
      expenditureFundingPotId,
      _amount,
      _token
    );
    colony.finalizeExpenditure(expenditureId);

    // Claim payout on behalf of the recipient
    colony.claimExpenditurePayout(expenditureId, _recipient, _token);
  }

  function validateCallerPermissions(
    uint256 _callerPermissionDomainId,
    uint256 _callerChildSkillIndex,
    uint256 _domainId
  )
    internal
    view
  {
    require(
      ColonyAuthority(colony.authority()).canCall(msg.sender, _callerPermissionDomainId, address(colony), MAKE_EXPENDITURE_SIG),
      "colony-one-tx-payment-administration-not-authorized"
    );

    require(
      ColonyAuthority(colony.authority()).canCall(msg.sender, _callerPermissionDomainId, address(colony), MOVE_FUNDS_SIG),
      "colony-one-tx-payment-funding-not-authorized"
    );

    if (_callerPermissionDomainId != _domainId) {
      uint256 permissionSkillId = colony.getDomain(_callerPermissionDomainId).skillId;
      uint256 domainSkillId = colony.getDomain(_domainId).skillId;
      require(domainSkillId > 0, "colony-one-tx-payment-domain-does-not-exist");

      uint256 childSkillId = colonyNetwork.getChildSkillId(permissionSkillId, _callerChildSkillIndex);
      require(childSkillId == domainSkillId, "colony-one-tx-payment-bad-child-skill");
    }
  }
}
