#!/usr/bin/env bash
# Stands in for the hermes CLI in tests: always "succeeds" with an empty
# object, reproducing the cold-start failure mode seen in production where
# a call returns valid-but-useless JSON. Ignores all arguments.
echo '{}'
