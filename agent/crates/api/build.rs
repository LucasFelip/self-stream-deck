fn main() {
    // the interface is packed into the executable: build again when web/dist changes
    println!("cargo:rerun-if-changed=../../../web/dist");
}
