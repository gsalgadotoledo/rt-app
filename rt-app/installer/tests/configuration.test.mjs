import test from "node:test";
import assert from "node:assert/strict";
import {validateInstallation} from "@gsalgadotoledo/rt-app-installer";
import {infrastructureProviders} from "@gsalgadotoledo/rt-app-infra/installation";
test("installer accepts only AWS and a valid repository", () => {
 const config={provider:"aws",region:"us-east-1",stack:"rt-app-test",mailFrom:"sender@example.test",repository:"owner/repo"};
 assert.equal(infrastructureProviders.length,1);
 assert.equal(validateInstallation(config),config);
 for(const override of [{provider:"azure"},{stack:"arbitrary"},{repository:"https://github.com/owner/repo"}]) assert.throws(()=>validateInstallation({...config,...override}));
});
