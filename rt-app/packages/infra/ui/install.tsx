import React, { useState } from "react";
import {
  infrastructureProviders,
  installationSteps,
  awsPermissionGroups,
} from "../src/installation";
export function InstallationGuide({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = installationSteps[step];
  return (
    <div className="setup-shell">
      <div className="profile-card">
        <p className="eyebrow">RT-APP / INSTALLATION</p>
        <h1>Prepare your application</h1>
        <p className="lead">
          Infra configures the cloud. Your modules use NoSQL.
        </p>
        <nav className="module-tabs">
          {installationSteps.map((s, i) => (
            <button
              key={s.title}
              className={i === step ? "active" : ""}
              onClick={() => setStep(i)}
            >
              {i + 1}
            </button>
          ))}
        </nav>
        <h2>{current.title}</h2>
        <p>{current.detail}</p>
        {step === 0 && (
          <label>
            Base provider
            <select defaultValue="aws" disabled>
              {infrastructureProviders.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.title}
                  {p.available ? " · default" : " · coming soon"}
                </option>
              ))}
            </select>
          </label>
        )}
        {step === 1 &&
          awsPermissionGroups.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <p>{g.detail}</p>
            </section>
          ))}
        {step === 2 && (
          <p>
            Detailed guide in <code>docs/installation.md</code>. Your organization's policies may require additional permissions or prevent deployment.
          </p>
        )}
        {step === 3 && (
          <>
            <pre>npm run setup</pre>
            <p>
              Run this command from the project folder. It uses that terminal's AWS profile. This guide does not request keys or create resources from the browser.
            </p>
          </>
        )}
        {step === 4 && (
          <p>
            This initial release supports DynamoDB. It does not move existing data between clouds or enable SQL.
          </p>
        )}
        {step === 5 && (
          <p>
            The wizard prepares the backend and the admin build. UI hosting and SES verification are configured separately.
          </p>
        )}
        <div className="pagination">
          <button disabled={step === 0} onClick={() => setStep(step - 1)}>
            Previous
          </button>
          {step < 5 ? (
            <button className="primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              Open local environment
            </button>
          )}
        </div>
        <button onClick={onClose}>Continue exploring locally</button>
      </div>
    </div>
  );
}
