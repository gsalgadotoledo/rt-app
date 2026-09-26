package featureflags

import (
	"rt.local/core-go/apperr"
	"rt.local/core-go/web"
)

// Feature exposes owner-only editing (mounted under /admin/app) and a public evaluator
// that never reveals targeting rules:
//
//	GET  /feature-flags?cursor=…   owner   one page of definitions
//	PUT  /feature-flags/:key       owner   {version, description, enabled, public, rollout, subjects}
//	POST /feature-flags/evaluate   guest   {keys: [...], subject?} → {key: bool}
func (f *FeatureFlags) Feature() web.Feature {
	return web.Feature{
		ID: "feature-flags",
		Endpoints: []web.Endpoint{
			{Method: "GET", Path: "/feature-flags", Access: web.Owner, Resource: "flags.manage", Handle: f.handleList},
			{Method: "PUT", Path: "/feature-flags/:key", Access: web.Owner, Resource: "flags.manage", Handle: f.handleSave},
			{Method: "POST", Path: "/feature-flags/evaluate", Access: web.Guest, Resource: "flags.evaluate", Handle: f.handleEvaluate},
		},
	}
}

func (f *FeatureFlags) handleList(c *web.Context) (any, error) {
	return f.List(c.Ctx, c.Request.Query["cursor"])
}

func (f *FeatureFlags) handleSave(c *web.Context) (any, error) {
	key := c.Params["key"]
	if err := ValidateKey(key); err != nil {
		return nil, err
	}
	def, err := DefinitionFrom(c.Request.Body)
	if err != nil {
		return nil, err
	}
	raw, present := c.Request.Body["version"]
	version, err := VersionFrom(raw, present)
	if err != nil {
		return nil, err
	}
	return f.Save(c.Ctx, key, def, version, c.Actor.ID)
}

func (f *FeatureFlags) handleEvaluate(c *web.Context) (any, error) {
	invalid := apperr.BadRequest("Provide up to 20 flag keys")
	list, ok := c.Request.Body["keys"].([]any)
	if !ok || len(list) > MaxEvaluateKeys {
		return nil, invalid
	}
	keys := make([]string, 0, len(list))
	for _, item := range list {
		key, ok := item.(string)
		if !ok {
			return nil, invalid
		}
		keys = append(keys, key)
	}
	raw, present := c.Request.Body["subject"]
	result := make(map[string]bool, len(keys))
	for _, key := range keys {
		// Checked per key, like the reference: no keys means no subject check.
		subject, err := SubjectFrom(raw, present)
		if err != nil {
			return nil, err
		}
		on, err := f.Enabled(c.Ctx, key, subject, true)
		if err != nil {
			return nil, err
		}
		result[key] = on
	}
	return result, nil
}
