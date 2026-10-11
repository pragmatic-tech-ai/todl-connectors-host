import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";

const Customer = "Customer";
const UnknownSource = "Nope";
const IdKey = "id";
const Label = "label";
const SeedId = "c1";
const SeedLabel = "Acme";
const NewId = "c2";
const NewLabel = "Globex";
const UpdatedLabel = "Acme 2";

/**
 * Contract every data-source adapter must satisfy. The adapter returned by `make`
 * must hold source Customer seeded with a record { id, label } = c1/Acme.
 * Re-declared here because the engine's copy is a test-only helper not exported from its root barrel.
 * `unknownSourceRejects` selects the fail-loud contract (single-source adapters) over the empty-result contract.
 * This is the sanctioned module-level function (test-contract helper, mirrors the engine's own).
 */
export function describeDataSourceAdapter(name: string, make: () => IDataSourceAdapter, unknownSourceRejects = false): void
{
    test(`${name}: Query returns only the requested fields per record`, async () =>
    {
        const rows = await make().Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.equal(rows.length, 1);
        assert.deepEqual(Object.keys(rows[0]!).sort(), [IdKey, Label]);
        assert.equal(rows[0]![IdKey], SeedId);
    });

    test(`${name}: an unknown source ${unknownSourceRejects ? "is rejected" : "yields no records"}`, async () =>
    {
        if (unknownSourceRejects)
        {
            await assert.rejects(make().Query({ Source: UnknownSource, Fields: [IdKey] }));
            return;
        }
        const rows = await make().Query({ Source: UnknownSource, Fields: [IdKey] });
        assert.deepEqual(rows, []);
    });

    test(`${name}: projecting a subset of fields drops the others`, async () =>
    {
        const rows = await make().Query({ Source: Customer, Fields: [IdKey] });
        assert.deepEqual(rows[0], { [IdKey]: SeedId });
        assert.equal(Label in rows[0]!, false);
    });

    test(`${name}: Apply upserts a new row that Query then returns`, async () =>
    {
        const adapter = make();
        const result = await adapter.Apply({
            Source: Customer, IdKey,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: NewId, Fields: { [Label]: NewLabel } }],
        });
        assert.equal(result.Applied, 1);
        assert.equal(result.Conflicts.length, 0);
        const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.find(r => r[IdKey] === NewId), { [IdKey]: NewId, [Label]: NewLabel });
    });

    test(`${name}: Apply upsert on an existing key overwrites`, async () =>
    {
        const adapter = make();
        await adapter.Apply({
            Source: Customer, IdKey,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: SeedId, Fields: { [Label]: UpdatedLabel } }],
        });
        const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.deepEqual(rows, [{ [IdKey]: SeedId, [Label]: UpdatedLabel }]);
    });

    test(`${name}: Apply delete removes the row`, async () =>
    {
        const adapter = make();
        const result = await adapter.Apply({
            Source: Customer, IdKey,
            Operations: [{ Kind: WriteOperationKind.Delete, Key: SeedId, Fields: {} }],
        });
        assert.equal(result.Applied, 1);
        assert.deepEqual(await adapter.Query({ Source: Customer, Fields: [IdKey] }), []);
    });
}
