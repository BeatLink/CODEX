#!/usr/bin/env bash
# Run the model assessment protocol (docs/3-roadmap.md, "Model choice") for one model.
#
#   evals/run_model_trial.sh MODEL.gguf OUTPUT_DIR [agents|reasoning|both]
#
# Run it from a checkout with a built dist/ (npm run build). It waits for the shared GPU lock and prints
# each step and tool call as it happens. If codex-daemon has a model loaded it holds the lock, so free it
# first with `codex suspend` (or stop the service) and resume afterwards.
set -uo pipefail

MODEL=${1:?usage: run_model_trial.sh MODEL.gguf OUTPUT_DIR [agents|reasoning|both]}
OUT=${2:?usage: run_model_trial.sh MODEL.gguf OUTPUT_DIR [agents|reasoning|both]}
SETS=${3:-both}
LOCK=/run/user/$(id -u)/codex-gpu.lock
NAME=$(basename "$MODEL" .gguf)
mkdir -p "$OUT"

run_set() {
    local set=$1 tasks=$2 runners=$3
    local since
    since=$(date "+%F %T")
    echo "== $NAME on $set ($runners) $(date +%T)"
    flock "$LOCK" nix develop -c node dist/core/evaluation.js \
        --tasks "$tasks" --runners "$runners" --repeat 3 --stream \
        --model-path "$MODEL" --output "$OUT/$NAME-$set.json" 2>&1 \
        | grep --line-buffered -v "^warning" | tee "$OUT/$NAME-$set.log"
    echo "exit ${PIPESTATUS[0]}; kernel GPU errors: $(journalctl -k --since "$since" --no-pager | grep -ciE "CrashCat|nvAssertFailed|xid")"
}

[[ $SETS == agents || $SETS == both ]] && run_set agents evals/agents_tasks.json tree,agents
[[ $SETS == reasoning || $SETS == both ]] && run_set reasoning evals/reasoning_tasks.json bare,tree
echo "done $(date +%T)"
