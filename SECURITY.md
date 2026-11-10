# Security

Coffer is a static page. It holds no keys, runs no server and stores no user data. Keys stay in
Nimiq Pay; the page asks the wallet for signatures and reads public networks.

## What a signature can do

- An approval names the CoW Protocol vault relayer as spender, for exactly the amount of the move.
  It is valid for one hour.
- An order names the signer as the only receiver, a minimum amount received, and a 20-minute
  lifetime.

## Reporting

Report a vulnerability through GitHub's private reporting on this repository
(Security → Report a vulnerability). Reports get an answer within three days.
