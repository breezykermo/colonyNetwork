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
pragma experimental "ABIEncoderV2";

import "./ColonyStorage.sol";


contract ColonyExpenditure is ColonyStorage {

  event ExpenditureAdded(uint256 expenditureCount);

  // Public functions

  function makeExpenditure(uint256 _permissionDomainId, uint256 _childSkillIndex, uint256 _domainId)
    public
    stoppable
    authDomain(_permissionDomainId, _childSkillIndex, _domainId)
    returns (uint256)
  {
    expenditureCount += 1;
    fundingPotCount += 1;

    fundingPots[fundingPotCount] = FundingPot({
      associatedType: FundingPotAssociatedType.Expenditure,
      associatedTypeId: expenditureCount,
      payoutsWeCannotMake: 0
    });

    expenditures[expenditureCount] = Expenditure({
      status: ExpenditureStatus.Active,
      owner: msg.sender,
      fundingPotId: fundingPotCount,
      domainId: _domainId,
      finalizedTimestamp: 0
    });

    emit FundingPotAdded(fundingPotCount);
    emit ExpenditureAdded(expenditureCount);

    return expenditureCount;
  }

  function transferExpenditure(uint256 _id, address _newOwner)
    public
    stoppable
    expenditureExists(_id)
    expenditureActive(_id)
    expenditureOnlyOwner(_id)
  {
    expenditures[_id].owner = _newOwner;
  }

  function cancelExpenditure(uint256 _id)
    public
    stoppable
    expenditureExists(_id)
    expenditureActive(_id)
    expenditureOnlyOwner(_id)
  {
    expenditures[_id].status = ExpenditureStatus.Cancelled;
  }

  function finalizeExpenditure(uint256 _id)
    public
    stoppable
    expenditureExists(_id)
    expenditureActive(_id)
    expenditureOnlyOwner(_id)
  {
    FundingPot storage fundingPot = fundingPots[expenditures[_id].fundingPotId];
    require(fundingPot.payoutsWeCannotMake == 0, "colony-expenditure-not-funded");

    expenditures[_id].status = ExpenditureStatus.Finalized;
    expenditures[_id].finalizedTimestamp = now;
  }

  function setExpenditureSkill(uint256 _id, address _recipient, uint256 _skillId)
    public
    stoppable
    expenditureExists(_id)
    expenditureActive(_id)
    expenditureOnlyOwner(_id)
    skillExists(_skillId)
    validGlobalSkill(_skillId)
  {
    expenditures[_id].skills[_recipient] = new uint256[](1);
    expenditures[_id].skills[_recipient][0] = _skillId;
  }

  function setExpenditurePayoutScalar(
    uint256 _permissionDomainId,
    uint256 _childSkillIndex,
    uint256 _id,
    address _recipient,
    uint256 _payoutScalar
  )
    public
    stoppable
    authDomain(_permissionDomainId, _childSkillIndex, expenditures[_id].domainId)
  {
    expenditures[_id].payoutScalars[_recipient] = _payoutScalar;
  }

  function setExpenditureClaimDelay(
    uint256 _permissionDomainId,
    uint256 _childSkillIndex,
    uint256 _id,
    address _recipient,
    uint256 _claimDelay
  )
    public
    stoppable
    authDomain(_permissionDomainId, _childSkillIndex, expenditures[_id].domainId)
  {
    expenditures[_id].claimDelays[_recipient] = _claimDelay;
  }

  // Public view functions

  function getExpenditureCount() public view returns (uint256) {
    return expenditureCount;
  }

  function getExpenditure(uint256 _id)
    public
    view
    returns (ExpenditureStatus, address, uint256, uint256, uint256)
  {
    Expenditure storage e = expenditures[_id];
    return (e.status, e.owner, e.fundingPotId, e.domainId, e.finalizedTimestamp);
  }

  function getExpenditureRecipient(uint256 _id, address _recipient)
    public
    view
    returns (uint256, uint256, uint256[] memory)
  {
    Expenditure storage e = expenditures[_id];
    return(e.claimDelays[_recipient], e.payoutScalars[_recipient], e.skills[_recipient]);
  }

  function getExpenditurePayout(uint256 _id, address _recipient, address _token)
    public
    view
    returns (uint256)
  {
    return expenditures[_id].payouts[_recipient][_token];
  }
}
