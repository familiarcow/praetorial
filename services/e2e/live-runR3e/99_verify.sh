#!/bin/sh
# Final step of the R3e live run (a live run is not DONE unless the verifier passes). Offline on this directory.
exec "$(dirname "$0")/../../verifier/final_step.sh" "$(cd "$(dirname "$0")" && pwd)" f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed
