package cache

import "rt.local/core-go/nosql/jsonstore"

// NewFile returns a cache in a local JSON file (FileCache), shared by every process on this
// machine; an empty path means ".rt-app/cache.json". The file is a jsonstore database: every
// write drops CACHE#, OBSERVER# and VISITS rows whose ttl (seconds) has passed in real time.
// Use a dedicated file, not the application database; small datasets only.
func NewFile(path, namespace string, opts ...Option) *NoSQL {
	if path == "" {
		path = ".rt-app/cache.json"
	}
	return NewNoSQL(jsonstore.New(path), namespace, opts...)
}

// FileStore is the former name of jsonstore.Store, kept for existing callers.
type FileStore = jsonstore.Store

// NewFileStore returns jsonstore.New(path).
func NewFileStore(path string) *FileStore { return jsonstore.New(path) }
