// Package uuid generates random (version 4) UUIDs, the ids of crypto.randomUUID().
package uuid

import (
	"crypto/rand"
	"encoding/hex"
)

// New returns a random UUID v4 in lowercase canonical form.
func New() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails (it crashes the program instead)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
