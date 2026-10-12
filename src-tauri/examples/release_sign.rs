//! Local key generation and CI signing. Private keys never enter the app binary.
use std::{env, fs, io::Cursor, path::PathBuf};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") => {
            let path = PathBuf::from(args.get(2).ok_or("Supply an absolute private-key path outside the repository")?);
            if !path.is_absolute() || path.exists() || path.with_extension("pub").exists() { return Err("Choose a new absolute path outside the repository".into()); }
            let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize()?;
            if path.parent().ok_or("Missing parent")?.canonicalize()?.starts_with(repo) { return Err("Private keys must be stored outside the repository".into()); }
            let password = rpassword::prompt_password("Signing key password: ")?;
            if password.is_empty() || password != rpassword::prompt_password("Confirm password: ")? { return Err("A nonempty, matching password is required".into()); }
            let keys = minisign::KeyPair::generate_encrypted_keypair(Some(password))?;
            fs::write(&path, keys.sk.to_box(None)?.to_string())?;
            fs::write(path.with_extension("pub"), keys.pk.to_box()?.to_string())?;
            println!("Key pair created. Back it up securely; copy only the .pub contents into src-tauri/update-public-key.txt.");
        }
        Some("sign") => {
            let path = PathBuf::from(args.get(2).ok_or("Supply metadata path")?);
            let secret = env::var("DUNEDROP_SIGNING_PRIVATE_KEY")?;
            let password = env::var("DUNEDROP_SIGNING_PASSWORD")?;
            if password.is_empty() { return Err("A signing password is required".into()); }
            let sk = minisign::SecretKeyBox::from_string(&secret)?.into_secret_key(Some(password))?;
            let bytes = fs::read(&path)?;
            let signature = minisign::sign(None, &sk, Cursor::new(&bytes), None, None)?.to_string();
            let key = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("update-public-key.txt"))?;
            let public = minisign_verify::PublicKey::from_base64(key.lines().find(|s| s.starts_with("RW")).ok_or("Update public key is not configured")?)?;
            public.verify(&bytes, &minisign_verify::Signature::decode(&signature)?, false)?;
            fs::write(format!("{}.minisig", path.display()), signature)?;
        }
        _ => return Err("Usage: release_sign generate <private-key-path> | sign <update.json>".into()),
    }
    Ok(())
}
