use hdk3::prelude::*;

entry_defs![Path::entry_def()];

fn path(s: &str) -> ExternResult<EntryHash> {
    let path = Path::from(s);
    path.ensure()?;
    Ok(path.hash()?)
}

fn base() -> ExternResult<EntryHash> {
    path("a")
}

fn target() -> ExternResult<EntryHash> {
    path("b")
}

#[derive(Serialize, Deserialize, SerializedBytes, Debug)]
pub struct TestObj {
    value: String,
}

#[hdk_extern]
fn returns_obj(_: ()) -> ExternResult<TestObj> {
    Ok(TestObj {
        value: "This is the returned value".to_string(),
    })
}

#[hdk_extern]
fn pass_obj(t: TestObj) -> ExternResult<TestObj> {
    Ok(t)
}

#[hdk_extern]
fn return_failure(_: TestObj) -> Result<TestObj, String> {
    Err("returned error".to_string())
}

#[hdk_extern]
fn create_link(_: ()) -> ExternResult<HeaderHash> {
    Ok(hdk3::prelude::create_link(base()?, target()?, ())?)
}

#[hdk_extern]
fn delete_link(input: DeleteLinkInput) -> ExternResult<HeaderHash> {
    Ok(hdk3::prelude::delete_link(input.into_inner())?)
}

#[hdk_extern]
fn get_links(_: ()) -> ExternResult<Links> {
    Ok(hdk3::prelude::get_links(base()?, None)?)
}

#[hdk_extern]
fn delete_all_links(_: ()) -> ExternResult<()> {
    for link in hdk3::prelude::get_links(base()?, None)?.into_inner() {
        hdk3::prelude::delete_link(link.create_link_hash)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, SerializedBytes, Debug)]
pub struct LoopBack {
    value: String,
}

#[hdk_extern]
fn signal_loopback(value: LoopBack) -> ExternResult<()> {
    emit_signal(&value)?;
    Ok(())
}
