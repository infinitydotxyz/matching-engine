// SPDX-License-Identifier: MIT

pragma solidity 0.8.14;

library Address {
    function isContract(address account) internal view returns (bool) {
        uint size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }
}
