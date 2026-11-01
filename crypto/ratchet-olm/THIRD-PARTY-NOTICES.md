# Third party source

`vendor/vodozemac` contains vodozemac 0.11.1 from Matrix.org, revision
`3e11ae87d157da6bcac3cbf7825d37c8f5ed60af`, under Apache-2.0.
The upstream license and copyright notices are retained in that directory.

Nivra modification, 2026: add the receiving-side initialization counterpart to
`Session::from_root_key_material`, using the existing receiving chain and
inactive sending ratchet constructors. The initial sending secret belongs only
to the initiator. This change is marked in `src/olm/session/mod.rs`.
No upstream primitive, key derivation, message encryption or ratchet advancement
is changed. The extension and Nivra handshake require their own verification;
the upstream audit does not cover these additions.

`vendor-upstream.json` records the unmodified upstream source hashes. The
dependency check rejects other source changes. This does not change Nivra's
overall license. Other dependency licenses are checked separately.
