package chunks

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// BenchmarkWriterWidth is where the value of Writers comes from.
//
// A chunk costs one file fsync and its share of a directory fsync, and an fsync
// is almost entirely waiting, so the question is how many the device will
// overlap. Run it with `go test ./internal/chunks -bench WriterWidth`.
//
// Measured over 3000 chunks of 3.4 KB, which is one 17 MiB vault's first sync:
//
//	                  Linux (Docker)      macOS (APFS)
//	width   1        1224 chunks/s        188 chunks/s
//	width   8        3865                 274
//	width  16        4527                 307
//	width  32        4737                 278
//	width  64        4339                 269
//
// Re-taken later on one machine, five runs a width, medians: Linux 1273 / 3707
// / 5231 / 5248 / 5189, macOS 183 / 277 / 295 / 270 / 280. Same shape, same
// conclusion. Worth saying how nearly it went the other way: a single run per
// width read 398 / 1182 / 1271 / 3372 / 4981, which looks exactly like a knee
// past 64 and would have argued for widening this. It was the first widths
// warming up. Rule 8, and one sample is not a measurement of an fsync.
//
// Linux is where this runs and macOS is where it is developed. The gap is
// F_FULLFSYNC, which Go issues for File.Sync on darwin and which flushes the
// drive's own cache; it barely overlaps at all, which is why the laptop figures
// flatten after eight. Sixteen is past the knee on both.
func BenchmarkWriterWidth(b *testing.B) {
	bodies := make([][]byte, 3000)
	for i := range bodies {
		body := make([]byte, 3400)
		copy(body, fmt.Sprintf("chunk %d ", i))
		bodies[i] = body
	}

	for _, width := range []int{1, 8, 16, 32, 64} {
		b.Run(fmt.Sprintf("width-%d", width), func(b *testing.B) {
			for b.Loop() {
				b.StopTimer()
				s, err := New(filepath.Join(b.TempDir(), "chunks"), 1<<20)
				if err != nil {
					b.Fatal(err)
				}
				w := s.newWriterWidth("v1", width)
				b.StartTimer()

				start := time.Now()
				for _, body := range bodies {
					if err := w.Add(Name(body), body); err != nil {
						b.Fatal(err)
					}
				}
				if err := w.Close(); err != nil {
					b.Fatal(err)
				}
				b.ReportMetric(float64(len(bodies))/time.Since(start).Seconds(), "chunks/s")
			}
		})
	}
}
