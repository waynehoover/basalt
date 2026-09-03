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

// Every error carries retryable, whatever else it carries: id only when it
// answers a request, retryAfterMs only when there is a hint to give.
func TestI2ErrShapes(t *testing.T) {
	answering := Error(CodeNoUID, "m")
	answering.ID = 7
	if b, _ := json.Marshal(answering); string(b) != `{"res":"err","id":7,"code":"nouid","msg":"m","retryable":false}` {
		t.Fatalf("the shape of an error answering a request: %s", b)
	}
	unsolicited := Error(CodeBusy, "m")
	unsolicited.RetryAfterMs = 5000
	b, _ := json.Marshal(unsolicited)
	if strings.Contains(string(b), `"id"`) || !strings.Contains(string(b), `"retryAfterMs":5000`) ||
		!strings.Contains(string(b), `"retryable":true`) {
		t.Fatalf("the shape of an unsolicited error: %s", b)
	}
	// Nothing can build an error without the verdict, because the field is not
	// omitted and not a pointer: the zero value is a stated "do not retry".
	if b, _ := json.Marshal(Err{Res: "err", Code: CodeAuth, Msg: "m"}); !strings.Contains(string(b), `"retryable":false`) {
		t.Fatalf("an error was built with no retryable: %s", b)
	}
}
