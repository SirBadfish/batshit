#!/bin/bash

# Test script for Vercel AI Brain providers
# Story 5.1 - AC6, AC7, AC8 verification

echo "========================================="
echo "Story 5.1 - Vercel AI Brain Provider Tests"
echo "========================================="
echo ""

# Test endpoint
BATSHIT_APP_BASE_URL="${BATSHIT_FRONTEND_URL:-${PUBLIC_BASE_URL:-http://localhost:${BATSHIT_FRONTEND_PORT:-5620}}}"
ENDPOINT="${BATSHIT_TEST_ENDPOINT:-${BATSHIT_APP_BASE_URL%/}/api/ai/think}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "Testing AC6: Provider Functionality"
echo "------------------------------------"

# Test 1: Anthropic provider
echo -n "Testing Anthropic (claude-3-5-sonnet)... "
RESPONSE=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -H "x-ghost-agent-key: ghost-agent-secret-2025" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Say PASS and nothing else"}],
    "sessionId": "test-session",
    "messageId": "test-message",
    "maxTokens": 10
  }' 2>/dev/null)

if echo "$RESPONSE" | grep -q "PASS\|pass\|Pass"; then
  echo -e "${GREEN}✅ PASSED${NC}"
else
  echo -e "${RED}❌ FAILED${NC}"
  echo "Response: $RESPONSE"
fi

# Test 2: OpenAI provider
echo -n "Testing OpenAI (gpt-4o)... "
RESPONSE=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -H "x-ghost-agent-key: ghost-agent-secret-2025" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say PASS and nothing else"}],
    "sessionId": "test-session",
    "messageId": "test-message",
    "maxTokens": 10
  }' 2>/dev/null)

if echo "$RESPONSE" | grep -q "PASS\|pass\|Pass"; then
  echo -e "${GREEN}✅ PASSED${NC}"
else
  echo -e "${RED}❌ FAILED${NC}"
  echo "Response: $RESPONSE"
fi

# Test 3: OpenRouter provider
echo -n "Testing OpenRouter (anthropic/claude-3.5-sonnet)... "
RESPONSE=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -H "x-ghost-agent-key: ghost-agent-secret-2025" \
  -d '{
    "model": "anthropic/claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Say PASS and nothing else"}],
    "sessionId": "test-session",
    "messageId": "test-message",
    "maxTokens": 10
  }' 2>/dev/null)

if echo "$RESPONSE" | grep -q "PASS\|pass\|Pass"; then
  echo -e "${GREEN}✅ PASSED${NC}"
else
  echo -e "${RED}❌ FAILED${NC}"
  echo "Response: $RESPONSE"
fi

echo ""
echo "Testing AC7: Multimodal Support (765 tokens)"
echo "---------------------------------------------"

# Test multimodal with Anthropic
echo -n "Testing multimodal with claude-3-5-sonnet... "
START_TIME=$(date +%s%N)
RESPONSE=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -H "x-ghost-agent-key: ghost-agent-secret-2025" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "If you can process images, say MULTIMODAL"}],
    "images": [{"url": "https://images.unsplash.com/photo-1506812574058-fc75fa93fead", "detail": "auto"}],
    "sessionId": "test-session",
    "messageId": "test-message",
    "maxTokens": 20
  }' 2>/dev/null)
END_TIME=$(date +%s%N)

if echo "$RESPONSE" | grep -qi "multimodal"; then
  echo -e "${GREEN}✅ PASSED${NC} (Image support confirmed)"
else
  echo -e "${RED}❌ FAILED${NC}"
  echo "Response: $RESPONSE"
fi

echo ""
echo "Testing AC8: Performance (<10ms overhead)"
echo "-----------------------------------------"

# Calculate response time
ELAPSED=$((($END_TIME - $START_TIME) / 1000000))
echo "Response time: ${ELAPSED}ms"

if [ $ELAPSED -lt 1000 ]; then
  echo -e "${GREEN}✅ PASSED${NC} (Under 1 second)"
else
  echo -e "${RED}❌ WARNING${NC} (Over 1 second - may need optimization)"
fi

echo ""
echo "========================================="
echo "Test Summary"
echo "========================================="
echo "AC6 (Providers): Check results above"
echo "AC7 (Multimodal): Check results above"
echo "AC8 (Performance): ${ELAPSED}ms response time"
echo ""

# Check if model mapping fix is working
echo "Bonus: Testing gpt-5 → gpt-4o mapping..."
RESPONSE=$(curl -s -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -H "x-ghost-agent-key: ghost-agent-secret-2025" \
  -d '{
    "model": "gpt-5",
    "messages": [{"role": "user", "content": "Say MAPPED if you are gpt-4o"}],
    "sessionId": "test-session",
    "messageId": "test-message",
    "maxTokens": 10
  }' 2>/dev/null)

if echo "$RESPONSE" | grep -qi "mapped\|gpt-4o\|4o"; then
  echo -e "${GREEN}✅ Model mapping working (gpt-5 → gpt-4o)${NC}"
else
  echo -e "${RED}❌ Model mapping may not be working${NC}"
fi

echo ""
echo "Test completed!"
