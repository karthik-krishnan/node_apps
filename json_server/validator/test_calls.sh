# 1) Start a session (auto-ends any previous and sets current.sessionId)
curl -s -X POST http://localhost:8000/sessions | jq .

# 2) Start a flow (requires active session; auto-ends previous flow; sets current.flowId)
curl -s -X POST http://localhost:8000/flows \
  -H 'Content-Type: application/json' \
  -d '{"flowId":"login","name":"Login Flow"}' | jq .

curl -X POST http://localhost:8000/ \
  -H "Content-Type: application/json"  --data "@../samples/login.json" | jq

curl -s -X POST http://localhost:8000/flows \
  -H 'Content-Type: application/json' \
  -d '{"flowId":"login_for_loyal_customer","name":"Login Flow for Loyal Customer"}' | jq .

curl -X POST http://localhost:8000/ \
  -H "Content-Type: application/json"  --data "@../samples/login.json" | jq

# # 3) Send events (no headers needed now; routed to current session/flow)
# curl -X POST http://localhost:8000/ \
#   -H "Content-Type: application/json"  --data "@../samples/invalid.json" | jq

# # 4) Start a flow (requires active session; auto-ends previous flow; sets current.flowId)
# curl -s -X POST http://localhost:8000/flows \
#   -H 'Content-Type: application/json' \
#   -d '{"flowId":"custom_validation_example","name":"Checkout With Offer Flow"}' | jq .

# 3) Send events (no headers needed now; routed to current session/flow)
# curl -X POST http://localhost:8000/ \
#   -H "Content-Type: application/json"  --data "@../samples/login.json" | jq

# # 4) Start a flow (requires active session; auto-ends previous flow; sets current.flowId)
# curl -s -X POST http://localhost:8000/flows \
#   -H 'Content-Type: application/json' \
#   -d '{"flowId":"checkout_with_offer","name":"Checkout With Offer Flow"}' | jq .

# # 5) Send events (no headers needed now; routed to current session/flow)
# curl -X POST http://localhost:8000/ \
#   -H "Content-Type: application/json"  --data "@../samples/invalid.json" | jq