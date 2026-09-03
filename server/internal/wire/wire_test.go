package wire

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The retryable column of the error table in docs/protocol.md is what
// Retryable returns. Read from the doc rather than restated here, so the two
// cannot drift without this failing.
func TestI2RetryableMatchesTheProtocolDoc(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/protocol.md")
	if err != nil {
		t.Skipf("protocol.md not beside the source: %v", err)
	}
	row := regexp.MustCompile("(?m)^\\| `([a-z]+)` \\| [^|]* \\| (yes|no)[^|]* \\| ")
	rows := row.FindAllStringSubmatch(string(doc), -1)
	if len(rows) < 10 {
		t.Fatalf("found %d error rows in the doc, expected the whole table", len(rows))
	}
	seen := map[string]bool{}
	for _, m := range rows {
		code, want := m[1], m[2] == "yes"
		seen[code] = true
		if got := Retryable(code); got != want {
			t.Errorf("Retryable(%q) = %v, the doc says %v", code, got, want)
		}
	}
	for _, code := range []string{CodeProto, CodeAuth, CodeCursor, CodeBusy, CodeProtoState, CodeBadChunk,
		CodeBadEntry, CodeBadName, CodeToolarge, CodeNoSpace, CodeNoUID, CodeNoContent, CodeNoChunk, CodeInternal} {
		if !seen[code] {
			t.Errorf("code %q has no row in the doc's error table", code)
		}
	}
}

// A protocol 2 error is code and message only; a protocol 3 error always
// carries retryable and only carries id and retryAfterMs when they mean
// something.
func TestI2ErrShapes(t *testing.T) {
	old, _ := json.Marshal(Error(CodeBusy, "m"))
	if string(old) != `{"res":"err","code":"busy","msg":"m"}` {
		t.Fatalf("protocol 2 shape: %s", old)
	}
	answering, _ := json.Marshal(Error(CodeNoUID, "m").ForProto3(7, 0))
	if string(answering) != `{"res":"err","id":7,"code":"nouid","msg":"m","retryable":false}` {
		t.Fatalf("protocol 3 answering shape: %s", answering)
	}
	unsolicited, _ := json.Marshal(Error(CodeBusy, "m").ForProto3(0, 5000))
	if strings.Contains(string(unsolicited), `"id"`) || !strings.Contains(string(unsolicited), `"retryAfterMs":5000`) ||
		!strings.Contains(string(unsolicited), `"retryable":true`) {
		t.Fatalf("protocol 3 unsolicited shape: %s", unsolicited)
	}
}
